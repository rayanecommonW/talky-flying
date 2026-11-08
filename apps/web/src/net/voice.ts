/**
 * Voice over LiveKit. One room at a time: "local" (proximity, spatial) or "fm-XXXX" (a station).
 * Switching the dial = leaving one room and joining the next; the mic track survives the switch.
 */
import {
  ConnectionState,
  createLocalAudioTrack,
  type LocalAudioTrack,
  type Participant,
  RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type TrackPublication,
} from "livekit-client";
import { LOCAL_ENTER_RADIUS, LOCAL_EXIT_RADIUS } from "@dead-air/shared";
import { audio, burst, makePanner, voiceChain, type Band } from "../audio/engine.ts";

type Peer = {
  track?: RemoteAudioTrack;
  panner?: PannerNode;
  band?: Band;
};

export type VoiceEvents = {
  onHostPresent: (present: boolean, hostName: string | null) => void;
  onSpeakers: (identities: string[]) => void;
  onDisconnected: () => void;
};

export class Voice {
  private room: Room | null = null;
  private mic: LocalAudioTrack | null = null;
  private peers = new Map<string, Peer>();
  private local = false;
  private connectSeq = 0;
  private subscribed = new Set<string>();

  constructor(private ev: VoiceEvents) {}

  /** Ask for the microphone up front (from the start button) so push-to-talk is instant later. */
  async initMic(): Promise<boolean> {
    try {
      this.mic = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      await this.mic.mute();
      return true;
    } catch (e) {
      console.warn("[voice] no microphone:", e);
      return false;
    }
  }

  get hasMic(): boolean {
    return this.mic !== null;
  }

  async leave(): Promise<void> {
    this.connectSeq++;
    const r = this.room;
    this.room = null;
    this.peers.clear();
    this.subscribed.clear();
    if (r) await r.disconnect(false);
  }

  async join(url: string, token: string, roomName: string): Promise<boolean> {
    await this.leave();
    const seq = this.connectSeq;
    this.local = roomName === "local";
    const room = new Room({ webAudioMix: { audioContext: audio() }, adaptiveStream: false, dynacast: false });
    room
      .on(RoomEvent.TrackSubscribed, (t, pub, p) => this.onSubscribed(t, pub, p))
      .on(RoomEvent.TrackUnsubscribed, (_t, _pub, p) => this.dropPeer(p.identity))
      .on(RoomEvent.TrackPublished, (pub, p) => {
        if (this.local && this.subscribed.has(p.identity)) pub.setSubscribed(true);
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.dropPeer(p.identity);
        this.subscribed.delete(p.identity);
        if (p.isAgent || p.attributes.role === "host") this.ev.onHostPresent(false, null);
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        if (p.isAgent || p.attributes.role === "host") this.ev.onHostPresent(true, p.attributes.host ?? null);
      })
      .on(RoomEvent.TrackMuted, (pub, p) => this.onRemoteMute(pub, p, true))
      .on(RoomEvent.TrackUnmuted, (pub, p) => this.onRemoteMute(pub, p, false))
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) =>
        this.ev.onSpeakers(speakers.filter((s) => s !== room.localParticipant).map((s) => s.identity)),
      )
      .on(RoomEvent.Disconnected, () => {
        if (this.room === room) this.ev.onDisconnected();
      });

    try {
      await room.connect(url, token, { autoSubscribe: !this.local });
    } catch (e) {
      console.warn("[voice] connect failed:", e);
      return false;
    }
    if (seq !== this.connectSeq) {
      await room.disconnect(false);
      return false;
    }
    this.room = room;
    if (this.mic) {
      await room.localParticipant.publishTrack(this.mic, { source: Track.Source.Microphone, dtx: true, red: true });
      await this.mic.mute();
    }
    const host = [...room.remoteParticipants.values()].find((p) => p.isAgent || p.attributes.role === "host");
    this.ev.onHostPresent(!!host, host?.attributes.host ?? null);
    return true;
  }

  get connected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  async setTransmitting(on: boolean): Promise<void> {
    if (!this.mic) return;
    if (on) await this.mic.unmute();
    else await this.mic.mute();
  }

  private bandFor(p: RemoteParticipant): Band {
    if (this.local) return "local";
    return p.isAgent || p.attributes.role === "host" ? "fm-host" : "fm-caller";
  }

  private onSubscribed(track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant): void {
    if (!(track instanceof RemoteAudioTrack)) return;
    const band = this.bandFor(p);
    const chain = voiceChain(band);
    const peer: Peer = { track, band };
    if (band === "local") {
      peer.panner = makePanner();
      chain.unshift(peer.panner);
    }
    track.setWebAudioPlugins(chain);
    track.attach(); // LiveKit routes the element through our AudioContext (webAudioMix)
    this.peers.set(p.identity, peer);
    if (band === "fm-host") this.ev.onHostPresent(true, p.attributes.host ?? null);
  }

  private onRemoteMute(pub: TrackPublication, p: Participant, muted: boolean): void {
    if (pub.kind !== Track.Kind.Audio || p === this.room?.localParticipant) return;
    // Squelch tail when someone unkeys; a tiny click when they key up.
    if (muted) burst(0.5, 160);
    else burst(0.25, 50);
  }

  private dropPeer(identity: string): void {
    const peer = this.peers.get(identity);
    peer?.track?.detach();
    this.peers.delete(identity);
  }

  /**
   * LOCAL only: subscribe to pilots in range (with hysteresis) and place their voices in 3D.
   * `positions` maps LiveKit identity (= world sessionId) to world position.
   */
  updateSpatial(
    listener: { pos: [number, number, number]; fwd: [number, number, number]; up: [number, number, number] },
    positions: Map<string, [number, number, number]>,
  ): number {
    const ctx = audio();
    const L = ctx.listener;
    const t = ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(listener.pos[0], t, 0.03);
      L.positionY.setTargetAtTime(listener.pos[1], t, 0.03);
      L.positionZ.setTargetAtTime(listener.pos[2], t, 0.03);
      L.forwardX.setTargetAtTime(listener.fwd[0], t, 0.03);
      L.forwardY.setTargetAtTime(listener.fwd[1], t, 0.03);
      L.forwardZ.setTargetAtTime(listener.fwd[2], t, 0.03);
      L.upX.setTargetAtTime(listener.up[0], t, 0.03);
      L.upY.setTargetAtTime(listener.up[1], t, 0.03);
      L.upZ.setTargetAtTime(listener.up[2], t, 0.03);
    } else {
      L.setPosition(...listener.pos);
      L.setOrientation(...listener.fwd, ...listener.up);
    }

    let inRange = 0;
    if (!this.room || !this.local) return 0;
    for (const p of this.room.remoteParticipants.values()) {
      const pos = positions.get(p.identity);
      const d = pos ? Math.hypot(pos[0] - listener.pos[0], pos[1] - listener.pos[1], pos[2] - listener.pos[2]) : Infinity;
      const was = this.subscribed.has(p.identity);
      const want = was ? d < LOCAL_EXIT_RADIUS : d < LOCAL_ENTER_RADIUS;
      if (want) inRange++;
      if (want !== was) {
        for (const pub of p.audioTrackPublications.values()) pub.setSubscribed(want);
        if (want) this.subscribed.add(p.identity);
        else this.subscribed.delete(p.identity);
      }
      const panner = this.peers.get(p.identity)?.panner;
      if (panner && pos) {
        panner.positionX.setTargetAtTime(pos[0], t, 0.03);
        panner.positionY.setTargetAtTime(pos[1], t, 0.03);
        panner.positionZ.setTargetAtTime(pos[2], t, 0.03);
      }
    }
    return inRange;
  }
}
