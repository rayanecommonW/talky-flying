import { Room, type Client, type CloseCode } from "colyseus";
import {
  dialLabel,
  isCallsign,
  isFm,
  isValidDial,
  LOCAL,
  MAX_DRONE_SPEED,
  MAX_ESCORTS,
  MAX_TX_MS,
  randomCallsign,
  roomForDial,
  toCard,
  type JoinOptions,
  type PoseMsg,
  type PttMsg,
  type PttReplyMsg,
  type TunedMsg,
  type TuneMsg,
  type WelcomeMsg,
  type WorldFeed,
  type CrashMsg,
} from "@dead-air/shared";
import { config } from "../config.ts";
import { services } from "../services.ts";
import { Pilot, WorldState } from "./schema.ts";

type Track = { lastPoseAt: number; txTimer?: { clear(): void }; tuneSeq: number };

/** Where each escort flies relative to its pilot: right, up, behind (metres, pilot's heading). */
const ESCORT_SLOTS: [number, number, number][] = [
  [-0.9, 0.35, 1.3],
  [0.9, 0.35, 1.3],
  [0, 0.8, 2.1],
  [-1.8, 0.15, 2.4],
  [1.8, 0.15, 2.4],
];
const ESCORT_TICK_MS = 50;
/** Further than this from its slot (a respawn, a teleport) and the escort just jumps there. */
const ESCORT_SNAP = 60;

function finite(xs: number[]): boolean {
  return xs.every((v) => typeof v === "number" && Number.isFinite(v));
}

export class WorldRoom extends Room<{ state: WorldState }> {
  maxClients = 64;
  state = new WorldState();
  private track = new Map<string, Track>();

  messages = {
    pose: (client: Client, msg: PoseMsg) => this.onPose(client, msg),
    tune: (client: Client, msg: TuneMsg) => void this.onTune(client, msg),
    ptt: (client: Client, msg: PttMsg) => this.onPtt(client, msg),
    crash: (client: Client, msg: CrashMsg) => this.onCrash(client, msg),
  };

  onCreate() {
    this.autoDispose = false;
    this.setPatchRate(50);
    services.feed = () => this.worldFeed();
    services.escort = (owner, count) => this.addEscorts(owner, count);
    this.setSimulationInterval((ms) => this.flyEscorts(ms / 1000), ESCORT_TICK_MS);
  }

  onJoin(client: Client, options: JoinOptions) {
    const taken = new Set([...this.state.pilots.values()].map((p) => p.callsign.split("/")[0]));
    let callsign = isCallsign(options?.callsign) && !taken.has(options.callsign) ? options.callsign : randomCallsign();
    while (taken.has(callsign)) callsign = randomCallsign();

    const spawn = this.spawnNearSomeone();
    const pilot = new Pilot();
    pilot.callsign = callsign;
    [pilot.x, pilot.y, pilot.z] = spawn;
    this.state.pilots.set(client.sessionId, pilot);
    this.track.set(client.sessionId, { lastPoseAt: Date.now(), tuneSeq: 0 });

    const welcome: WelcomeMsg = { sessionId: client.sessionId, callsign, livekitUrl: config.livekitPublicUrl, spawn };
    client.send("welcome", welcome);
    services.pushEvent({ t: Date.now(), kind: "join", callsign, landmark: services.landmarks.near(spawn[0], spawn[2])?.name ?? null });
    console.log(`[world] ${callsign} joined (${this.state.pilots.size} pilots)`);
  }

  onDrop(client: Client, _code: CloseCode) {
    this.releaseFloor(client.sessionId);
    this.allowReconnection(client, 20).catch(() => {});
  }

  onLeave(client: Client) {
    const pilot = this.state.pilots.get(client.sessionId);
    this.releaseFloor(client.sessionId);
    this.state.pilots.delete(client.sessionId);
    this.track.delete(client.sessionId);
    for (const id of this.escortsOf(client.sessionId)) this.state.pilots.delete(id);
    if (pilot) {
      services.pushEvent({ t: Date.now(), kind: "leave", callsign: pilot.callsign, landmark: services.landmarks.near(pilot.x, pilot.z)?.name ?? null });
      console.log(`[world] ${pilot.callsign} left`);
    }
  }

  /** Client-authoritative movement, server-validated: reject teleports and impossible speeds. */
  private onPose(client: Client, msg: PoseMsg) {
    const pilot = this.state.pilots.get(client.sessionId);
    const tr = this.track.get(client.sessionId);
    if (!pilot || !tr || !Array.isArray(msg?.p) || !Array.isArray(msg?.q)) return;
    const [x, y, z] = msg.p;
    const [qx, qy, qz, qw] = msg.q;
    if (!finite([x, y, z, qx, qy, qz, qw])) return;
    const now = Date.now();
    const dt = Math.max((now - tr.lastPoseAt) / 1000, 0.05);
    const dist = Math.hypot(x - pilot.x, y - pilot.y, z - pilot.z);
    // Generous slack for jitter and bursts after a stall; respawns are announced via "crash".
    if (dist > MAX_DRONE_SPEED * dt * 2 + 5) return;
    tr.lastPoseAt = now;
    pilot.x = x;
    pilot.y = y;
    pilot.z = z;
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    pilot.qx = qx / n;
    pilot.qy = qy / n;
    pilot.qz = qz / n;
    pilot.qw = qw / n;
  }

  private onCrash(client: Client, msg: CrashMsg) {
    const pilot = this.state.pilots.get(client.sessionId);
    const tr = this.track.get(client.sessionId);
    if (!pilot || !tr) return;
    services.pushEvent({
      t: Date.now(),
      kind: "crash",
      callsign: pilot.callsign,
      landmark: services.landmarks.near(pilot.x, pilot.z)?.name ?? null,
    });
    // After a crash the client respawns somewhere else; let the next pose through.
    const spawn = services.spawns[Math.floor(Math.random() * services.spawns.length)];
    [pilot.x, pilot.y, pilot.z] = spawn;
    tr.lastPoseAt = Date.now();
    client.send("respawn", { spawn, speed: msg?.speed ?? 0 });
  }

  // ---------- escorts: drones a radio host sends to tag along behind a pilot. They only follow. ----------

  private escortsOf(owner: string): string[] {
    return [...this.state.pilots.entries()].filter(([, p]) => p.owner === owner).map(([id]) => id);
  }

  /** Returns how many escorts the pilot has afterwards, or null if there's no such pilot. */
  addEscorts(owner: string, count: number): number | null {
    const pilot = this.state.pilots.get(owner);
    if (!pilot || pilot.owner) return null;
    const have = this.escortsOf(owner);
    const used = new Set(have.map((id) => Number(id.split(":").pop())));
    let added = 0;
    for (let slot = 0; slot < MAX_ESCORTS && added < count; slot++) {
      if (used.has(slot)) continue;
      const e = new Pilot();
      e.callsign = `${pilot.callsign}/E${slot + 1}`;
      e.owner = owner;
      // Come in from above, so they arrive rather than pop in.
      [e.x, e.y, e.z] = [pilot.x, pilot.y + 25, pilot.z];
      this.state.pilots.set(`escort:${owner}:${slot}`, e);
      added++;
    }
    if (added) console.log(`[world] ${pilot.callsign} got ${added} escort(s), ${have.length + added} now`);
    return have.length + added;
  }

  private flyEscorts(dt: number) {
    const t = Date.now() / 1000;
    for (const [id, e] of this.state.pilots) {
      if (!e.owner) continue;
      const o = this.state.pilots.get(e.owner);
      if (!o) {
        this.state.pilots.delete(id);
        continue;
      }
      const slot = Number(id.split(":").pop());
      const [sx, sy, sz] = ESCORT_SLOTS[slot] ?? ESCORT_SLOTS[0];
      // Pilot's heading from its quaternion: forward is -Z.
      const fx = -2 * (o.qx * o.qz + o.qw * o.qy);
      const fz = -(1 - 2 * (o.qx * o.qx + o.qy * o.qy));
      const yaw = Math.atan2(-fx, -fz);
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const bob = 0.12 * Math.sin(t * 2.1 + slot * 1.7);
      // right = (c, 0, -s), behind = (s, 0, c)
      const tx = o.x + sx * c + sz * s;
      const ty = o.y + sy + bob;
      const tz = o.z - sx * s + sz * c;
      const d = Math.hypot(tx - e.x, ty - e.y, tz - e.z);
      const k = d > ESCORT_SNAP ? 1 : 1 - Math.exp(-3.5 * dt);
      const vx = (tx - e.x) * k;
      const vz = (tz - e.z) * k;
      e.x += vx;
      e.y += (ty - e.y) * k;
      e.z += vz;
      // Face the pilot's heading, leaning into the catch-up like a real quad.
      const v = Math.hypot(vx, vz) / Math.max(dt, 1e-3);
      const lean = Math.min(0.5, v * 0.02) / 2;
      const hy = yaw / 2;
      // yaw about Y, then pitch nose-down about local X
      const [qyy, qyw] = [Math.sin(hy), Math.cos(hy)];
      const [qxx, qxw] = [-Math.sin(lean), Math.cos(lean)];
      e.qx = qyw * qxx;
      e.qy = qyy * qxw;
      e.qz = -qyy * qxx;
      e.qw = qyw * qxw;
    }
  }

  /** New pilots spawn near someone already flying, so LOCAL has somebody to hear. */
  private spawnNearSomeone(): [number, number, number] {
    const spawns = services.spawns;
    const others = [...this.state.pilots.values()].filter((p) => !p.owner);
    if (!others.length) return spawns[Math.floor(Math.random() * spawns.length)];
    const o = others[Math.floor(Math.random() * others.length)];
    let best = spawns[0];
    let bestD = Infinity;
    for (const s of spawns) {
      const d = Math.hypot(s[0] - o.x, s[2] - o.z);
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  private async onTune(client: Client, msg: TuneMsg) {
    const pilot = this.state.pilots.get(client.sessionId);
    const tr = this.track.get(client.sessionId);
    if (!pilot || !tr || !isValidDial(msg?.dial)) return;
    const dial = msg.dial;
    const seq = ++tr.tuneSeq;
    this.releaseFloor(client.sessionId);
    pilot.dial = dial;
    pilot.tx = false;

    const room = roomForDial(dial);
    let card: TunedMsg["station"] = null;
    if (isFm(dial)) {
      if (!services.stations.get(dial)) client.send("tuning", { dial, status: "generating" });
      const bible = await services.stations.getOrCreate(dial);
      if (seq !== tr.tuneSeq || !this.state.pilots.has(client.sessionId)) return; // tuned away meanwhile
      const listeners = this.listenersOn(dial);
      let onAir = true;
      try {
        if (!(await services.voice.hasAgent(room)) && this.liveStations() > config.maxOnAir) {
          onAir = false; // transmitter budget exhausted: the frequency still works as a walkie-talkie channel
        } else {
          await services.voice.ensureHost(room, dial);
        }
      } catch (err) {
        console.warn(`[world] could not dispatch host to ${room}:`, (err as Error).message);
        onAir = false;
      }
      card = toCard(bible, onAir, listeners);
    }
    if (seq !== tr.tuneSeq) return;
    const token = await services.voice.token(client.sessionId, pilot.callsign, room);
    const tuned: TunedMsg = { dial, room, token, station: card };
    client.send("tuned", tuned);
    console.log(`[world] ${pilot.callsign} tuned ${dialLabel(dial)}${card ? ` "${card.name}"${card.onAir ? "" : " (off air)"}` : ""}`);
  }

  /**
   * Push-to-talk. FM is half-duplex: one caller holds the floor. LOCAL is open air:
   * anyone can key up at once.
   */
  private onPtt(client: Client, msg: PttMsg) {
    const pilot = this.state.pilots.get(client.sessionId);
    const tr = this.track.get(client.sessionId);
    if (!pilot || !tr) return;
    const reply = (r: PttReplyMsg) => client.send("ptt", r);

    if (!msg?.down) {
      this.releaseFloor(client.sessionId);
      pilot.tx = false;
      return;
    }
    if (pilot.dial !== LOCAL) {
      const key = String(pilot.dial);
      const holder = this.state.floors.get(key);
      if (holder && holder !== client.sessionId) return reply({ granted: false, reason: "busy" });
      this.state.floors.set(key, client.sessionId);
    }
    pilot.tx = true;
    tr.txTimer?.clear();
    tr.txTimer = this.clock.setTimeout(() => {
      if (!pilot.tx) return;
      this.releaseFloor(client.sessionId);
      pilot.tx = false;
      reply({ granted: false, reason: "timeout" });
    }, MAX_TX_MS);
    reply({ granted: true });
  }

  private releaseFloor(sessionId: string) {
    const tr = this.track.get(sessionId);
    tr?.txTimer?.clear();
    for (const [dial, holder] of this.state.floors) {
      if (holder === sessionId) this.state.floors.delete(dial);
    }
    const pilot = this.state.pilots.get(sessionId);
    if (pilot) pilot.tx = false;
  }

  private listenersOn(dial: number): number {
    let n = 0;
    for (const p of this.state.pilots.values()) if (!p.owner && p.dial === dial) n++;
    return n;
  }

  private liveStations(): number {
    const dials = new Set<number>();
    for (const p of this.state.pilots.values()) if (isFm(p.dial)) dials.add(p.dial);
    return dials.size;
  }

  private worldFeed(): WorldFeed {
    const listenersByDial: Record<string, number> = {};
    const byLandmark = new Map<string, string[]>();
    let pilots = 0;
    for (const p of this.state.pilots.values()) {
      if (p.owner) continue;
      pilots++;
      const k = dialLabel(p.dial);
      listenersByDial[k] = (listenersByDial[k] ?? 0) + 1;
      const lm = services.landmarks.near(p.x, p.z);
      const name = lm?.name ?? (p.y > 80 ? "high over the city" : "the back streets");
      byLandmark.set(name, [...(byLandmark.get(name) ?? []), p.callsign]);
    }
    const hotspots = [...byLandmark.entries()]
      .map(([landmark, pilots]) => ({ landmark, pilots }))
      .sort((a, b) => b.pilots.length - a.pilots.length);
    return {
      city: "Port Ardent",
      pilots,
      escorts: [...this.state.pilots.values()].filter((p) => p.owner).length,
      listenersByDial,
      hotspots,
      recentEvents: services.events.slice(-12),
    };
  }
}
