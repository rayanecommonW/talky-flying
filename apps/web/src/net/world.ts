import { Callbacks, Client, type Room } from "@colyseus/sdk";
import {
  WORLD_ROOM,
  type Dial,
  type PttReplyMsg,
  type StationCard,
  type TunedMsg,
  type TuningMsg,
  type WelcomeMsg,
} from "@dead-air/shared";
import { SnapBuffer } from "./interp.ts";

/** Game server. Empty in a production build without VITE_GAME_URL: the client flies solo. */
export const GAME_URL: string =
  import.meta.env.VITE_GAME_URL ?? (import.meta.env.DEV ? `${location.protocol}//${location.hostname}:2567` : "");

const CONNECT_TIMEOUT_MS = 8000;

export type RemotePilot = {
  id: string;
  callsign: string;
  dial: Dial;
  tx: boolean;
  /** Escort drones: the sessionId they follow. Empty for real pilots. */
  owner: string;
  buf: SnapBuffer;
};

type Handlers = {
  onTuned: (m: TunedMsg) => void;
  onTuning: (m: TuningMsg) => void;
  onPtt: (m: PttReplyMsg) => void;
  onRespawn: (spawn: [number, number, number]) => void;
  onFloor: (holders: Map<string, string>) => void;
  onLeave: (code: number) => void;
};

/** Connection to the authoritative world room: our pose out, everyone else's in. */
export class World {
  room: Room | null = null;
  welcome!: WelcomeMsg;
  pilots = new Map<string, RemotePilot>();
  floors = new Map<string, string>();
  private lastPoseSent = 0;

  get connected(): boolean {
    return !!this.room;
  }

  async connect(callsign: string | undefined, h: Handlers): Promise<WelcomeMsg> {
    if (!GAME_URL) throw new Error("no game server configured");
    const client = new Client(GAME_URL);
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer")), CONNECT_TIMEOUT_MS));
    const room = await Promise.race([client.joinOrCreate(WORLD_ROOM, { callsign }), timeout]);
    this.room = room;
    const welcome = new Promise<WelcomeMsg>((resolve) => room.onMessage("welcome", resolve));
    room.onMessage("tuned", h.onTuned);
    room.onMessage("tuning", h.onTuning);
    room.onMessage("ptt", h.onPtt);
    room.onMessage("respawn", (m: { spawn: [number, number, number] }) => h.onRespawn(m.spawn));
    room.onLeave(h.onLeave);

    // The room is untyped on the client; the schema lives on the server.
    const cb = Callbacks.get(room) as any;
    cb.onAdd("pilots", (pilot: any, id: string) => {
      if (id === room.sessionId) return;
      const rp: RemotePilot = { id, callsign: pilot.callsign, dial: pilot.dial, tx: pilot.tx, owner: pilot.owner ?? "", buf: new SnapBuffer() };
      this.pilots.set(id, rp);
      const snap = () =>
        rp.buf.push({ t: performance.now(), p: [pilot.x, pilot.y, pilot.z], q: [pilot.qx, pilot.qy, pilot.qz, pilot.qw] });
      snap();
      cb.onChange(pilot, () => {
        rp.dial = pilot.dial;
        rp.tx = pilot.tx;
        snap();
      });
    });
    cb.onRemove("pilots", (_p: any, id: string) => {
      this.pilots.delete(id);
    });
    cb.onAdd("floors", (holder: string, dial: string) => {
      this.floors.set(dial, holder);
      h.onFloor(this.floors);
    });
    cb.onRemove("floors", (_holder: string, dial: string) => {
      this.floors.delete(dial);
      h.onFloor(this.floors);
    });
    cb.onChange("floors", () => h.onFloor(this.floors));

    this.welcome = await welcome;
    return this.welcome;
  }

  sendPose(p: [number, number, number], q: [number, number, number, number], now: number): void {
    if (now - this.lastPoseSent < 50) return;
    this.lastPoseSent = now;
    this.room?.send("pose", { p, q });
  }

  tune(dial: Dial): void {
    this.room?.send("tune", { dial });
  }

  ptt(down: boolean): void {
    this.room?.send("ptt", { down });
  }

  crash(speed: number): void {
    this.room?.send("crash", { speed });
  }

  /** Real pilots, not counting escort drones. */
  get humans(): number {
    let n = 0;
    for (const p of this.pilots.values()) if (!p.owner) n++;
    return n;
  }

  /** Escort drones following us. */
  get myEscorts(): number {
    let n = 0;
    for (const p of this.pilots.values()) if (this.room && p.owner === this.room.sessionId) n++;
    return n;
  }

  get sessionId(): string {
    return this.room?.sessionId ?? "solo";
  }
}

export async function fetchStations(): Promise<StationCard[]> {
  if (!GAME_URL) return [];
  try {
    const r = await fetch(`${GAME_URL}/api/stations`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? ((await r.json()) as StationCard[]) : [];
  } catch {
    return [];
  }
}
