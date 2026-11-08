/**
 * The radio: turns dial input into tune requests (debounced, with static while the knob moves),
 * connects voice when the server grants a room, and runs push-to-talk with floor control.
 */
import { dialLabel, isFm, LOCAL, stepDial, type Dial, type PttReplyMsg, type TunedMsg } from "@dead-air/shared";
import { setStatic, sweepStatic, tones, burst } from "../audio/engine.ts";
import { useGame } from "../state/store.ts";
import type { Voice } from "./voice.ts";
import type { World } from "./world.ts";

const TUNE_DEBOUNCE_MS = 350;
const HOST_WATCHDOG_MS = 12_000;
const STATIC_LIVE = { local: 0.015, fm: 0.04, offAir: 0.55 };

export class Radio {
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private pttHeld = false;
  private hostPresent = false;

  constructor(
    private world: World,
    private voice: Voice,
  ) {}

  private get s() {
    return useGame.getState();
  }

  /** Move the dial. Audio drops to static immediately; the actual tune happens when the knob rests. */
  turn(dial: Dial): void {
    if (dial === this.s.dial && this.s.radio !== "idle") return;
    this.releasePtt();
    this.s.set({ dial, radio: "tuning", station: null });
    sweepStatic(dial);
    setStatic(0.8, 40);
    tones.click();
    void this.voice.leave();
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.world.tune(dial), TUNE_DEBOUNCE_MS);
  }

  step(delta: number): void {
    this.turn(stepDial(this.s.dial, delta));
  }

  toggleLocal(): void {
    if (this.s.dial === LOCAL) {
      const last = Number(localStorage.getItem("deadair.lastFm")) || 983;
      this.turn(last);
    } else {
      this.turn(LOCAL);
    }
  }

  preset(n: number): void {
    const p = this.s.presets[n - 1];
    if (p) this.turn(p.dial);
  }

  onTuning(dial: Dial): void {
    if (dial === this.s.dial) this.s.set({ radio: "acquiring" });
  }

  async onTuned(m: TunedMsg): Promise<void> {
    if (m.dial !== this.s.dial) return; // knob moved on since
    this.s.set({ radio: "connecting", station: m.station, tunedDial: m.dial });
    if (isFm(m.dial)) localStorage.setItem("deadair.lastFm", String(m.dial));
    this.hostPresent = false;
    const ok = await this.voice.join(this.world.welcome.livekitUrl, m.token, m.room);
    if (m.dial !== this.s.dial) return;
    if (!ok) {
      this.s.set({ radio: "off-air" });
      setStatic(STATIC_LIVE.offAir);
      return;
    }
    if (m.dial === LOCAL) {
      this.s.set({ radio: "live" });
      setStatic(STATIC_LIVE.local, 400);
      return;
    }
    if (m.station && !m.station.onAir) {
      this.s.set({ radio: "off-air" });
      setStatic(STATIC_LIVE.offAir * 0.6, 400);
      return;
    }
    if (this.hostPresent) this.goLive();
    else this.armWatchdog(m.dial);
  }

  onHostPresent(present: boolean, hostName: string | null): void {
    this.hostPresent = present;
    const s = this.s;
    if (!isFm(s.dial) || s.tunedDial !== s.dial) return;
    if (present) this.goLive(hostName);
    else if (s.radio === "live") {
      s.set({ radio: "connecting" });
      setStatic(0.3, 300);
      this.armWatchdog(s.dial);
    }
  }

  private goLive(hostName?: string | null): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    const s = this.s;
    if (hostName && s.station && s.station.host !== hostName) s.set({ station: { ...s.station, host: hostName } });
    s.set({ radio: "live" });
    setStatic(STATIC_LIVE.fm, 600);
  }

  /** If the host never shows up (agent restarted, room raced a shutdown), ask the server again. */
  private armWatchdog(dial: Dial): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.s.dial === dial && !this.hostPresent && this.s.radio !== "off-air") {
        console.info(`[radio] no host on ${dialLabel(dial)} yet, re-tuning`);
        this.world.tune(dial);
      }
    }, HOST_WATCHDOG_MS);
  }

  onVoiceDropped(): void {
    const s = this.s;
    if (s.radio === "live" || s.radio === "connecting") {
      setStatic(0.6, 100);
      s.set({ radio: "tuning" });
      this.world.tune(s.dial);
    }
  }

  // ---------- push-to-talk ----------

  pressPtt(): void {
    if (this.pttHeld) return;
    this.pttHeld = true;
    const s = this.s;
    if (!this.voice.hasMic) {
      tones.denied();
      return;
    }
    if (s.radio !== "live" && s.radio !== "off-air") {
      tones.denied();
      return;
    }
    if (s.dial === LOCAL) {
      // open air: key up immediately, the server just records that we're transmitting
      s.set({ ptt: "on" });
      tones.keyUp();
      void this.voice.setTransmitting(true);
      this.world.ptt(true);
      return;
    }
    s.set({ ptt: "requesting" });
    this.world.ptt(true);
  }

  onPttReply(m: PttReplyMsg): void {
    const s = this.s;
    if (m.granted) {
      if (!this.pttHeld) {
        this.world.ptt(false); // released before the grant arrived
        return;
      }
      s.set({ ptt: "on" });
      tones.keyUp();
      void this.voice.setTransmitting(true);
    } else {
      if (m.reason === "busy") {
        s.set({ ptt: "busy" });
        tones.busy();
      } else if (m.reason === "timeout") {
        tones.denied();
        void this.voice.setTransmitting(false);
        s.set({ ptt: "off" });
      }
    }
  }

  releasePtt(): void {
    if (!this.pttHeld) return;
    this.pttHeld = false;
    const was = this.s.ptt;
    this.s.set({ ptt: "off" });
    void this.voice.setTransmitting(false);
    this.world.ptt(false);
    if (was === "on") {
      tones.roger();
      burst(0.35, 120);
    }
  }
}
