/**
 * Web Audio graph for the radio: one AudioContext, a master bus, a static generator,
 * per-band voice filter chains and UI tones. Each band sounds different so you know
 * which layer you are on before anyone speaks.
 */

import { settings, useSettings } from "../state/settings.ts";

let ctx: AudioContext | null = null;
let master: GainNode;
/** Mixer buses: static and UI tones get their own faders so they can be turned down or off. */
let staticBus: GainNode;
let toneBus: GainNode;
let staticGain: GainNode;
let staticFilter: BiquadFilterNode;
/** Last gain stage of every voice chain. LiveKit routes voices straight to the destination, so master applies here too. */
const voiceGains = new Set<GainNode>();

function applyLevels() {
  if (!ctx) return;
  const s = settings();
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(s.volMaster, t, 0.02);
  staticBus.gain.setTargetAtTime(s.volStatic, t, 0.02);
  toneBus.gain.setTargetAtTime(s.volTones, t, 0.02);
  for (const g of voiceGains) g.gain.setTargetAtTime(s.volMaster * s.volVoice, t, 0.02);
}
useSettings.subscribe((s, p) => {
  if (s.volMaster !== p.volMaster || s.volVoice !== p.volVoice || s.volStatic !== p.volStatic || s.volTones !== p.volTones) applyLevels();
});

export type Band = "local" | "fm-host" | "fm-caller";

export function audio(): AudioContext {
  if (!ctx) throw new Error("audio not started");
  return ctx;
}

/** Must be called from a user gesture. */
export async function startAudio(): Promise<AudioContext> {
  if (ctx) {
    await ctx.resume();
    return ctx;
  }
  ctx = new AudioContext({ latencyHint: "interactive" });
  master = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);
  staticBus = ctx.createGain();
  staticBus.connect(master);
  toneBus = ctx.createGain();
  toneBus.connect(master);
  applyLevels();

  // Static: looped white noise through a band-pass, level driven by the radio state.
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.002 ? 2.5 : 1);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  staticFilter = ctx.createBiquadFilter();
  staticFilter.type = "bandpass";
  staticFilter.frequency.value = 2200;
  staticFilter.Q.value = 0.6;
  staticGain = ctx.createGain();
  staticGain.gain.value = 0;
  noise.connect(staticFilter).connect(staticGain).connect(staticBus);
  noise.start();
  await ctx.resume();
  return ctx;
}


/** Static level 0..1. Ramps so dial turning sounds continuous. */
export function setStatic(level: number, ms = 120): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  staticGain.gain.cancelScheduledValues(t);
  staticGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.35, t, ms / 3000);
}

/** Sweep the static's colour while the dial turns. */
export function sweepStatic(dial: number): void {
  if (!ctx) return;
  staticFilter.frequency.setTargetAtTime(900 + ((dial * 37) % 2800), ctx.currentTime, 0.02);
}

/** Short burst of static: squelch tail when someone unkeys, or a crash. */
export function burst(level = 0.6, ms = 180): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  const g = staticGain.gain;
  const base = g.value;
  g.cancelScheduledValues(t);
  g.setValueAtTime(level * 0.35, t);
  g.setTargetAtTime(base, t + ms / 1000, 0.05);
}

function makeDrive(amount: number): WaveShaperNode {
  const sh = audio().createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  sh.curve = curve;
  sh.oversample = "2x";
  return sh;
}

/**
 * Filter chain for a voice on a given band, returned as an ordered list of nodes
 * (LiveKit's setWebAudioPlugins wires them in series).
 */
export function voiceChain(band: Band): AudioNode[] {
  const c = audio();
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  const peak = c.createBiquadFilter();
  peak.type = "peaking";
  const gain = c.createGain();
  const out = c.createGain();
  out.gain.value = settings().volMaster * settings().volVoice;
  voiceGains.add(out);
  if (band === "fm-host") {
    // broadcast FM: wide and warm, a little compressed
    hp.frequency.value = 90;
    lp.frequency.value = 7500;
    peak.frequency.value = 2800;
    peak.gain.value = 2;
    gain.gain.value = 1.1;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    return [hp, lp, peak, makeDrive(1.3), comp, gain, out];
  }
  if (band === "fm-caller") {
    // callers phone in over a narrow, crunchy line
    hp.frequency.value = 400;
    lp.frequency.value = 3000;
    peak.frequency.value = 1600;
    peak.gain.value = 6;
    gain.gain.value = 1.3;
    return [hp, lp, peak, makeDrive(3), gain, out];
  }
  // local: handheld walkie-talkie
  hp.frequency.value = 300;
  lp.frequency.value = 3400;
  peak.frequency.value = 1900;
  peak.gain.value = 4;
  gain.gain.value = 1.6;
  return [hp, lp, peak, makeDrive(2.2), gain, out];
}

/** Forget a voice chain's output stage once its track is gone. */
export function releaseChain(chain: AudioNode[]): void {
  const last = chain[chain.length - 1];
  if (last instanceof GainNode) voiceGains.delete(last);
}

export function makePanner(): PannerNode {
  const p = audio().createPanner();
  p.panningModel = "HRTF";
  p.distanceModel = "inverse";
  p.refDistance = 10;
  p.maxDistance = 400;
  p.rolloffFactor = 1.4;
  return p;
}

function beep(freqs: [number, number][], gain = 0.12): void {
  if (!ctx) return;
  let t = ctx.currentTime + 0.005;
  for (const [f, ms] of freqs) {
    if (f <= 0) {
      t += ms / 1000;
      continue;
    }
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.setValueAtTime(gain, t + ms / 1000 - 0.01);
    g.gain.linearRampToValueAtTime(0, t + ms / 1000);
    o.connect(g).connect(toneBus);
    o.start(t);
    o.stop(t + ms / 1000 + 0.01);
    t += ms / 1000;
  }
}

export const tones = {
  keyUp: () => beep([[1400, 40]], 0.06),
  roger: () => beep([[1200, 60], [900, 80]], 0.08),
  busy: () => beep([[420, 120], [0, 60], [420, 120]], 0.1),
  denied: () => beep([[300, 220]], 0.1),
  click: () => beep([[2400, 12]], 0.05),
};
