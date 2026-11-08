/** Snapshot interpolation for remote drones: render ~120 ms in the past, lerp position, slerp rotation. */

export type Snap = { t: number; p: [number, number, number]; q: [number, number, number, number] };

export const INTERP_DELAY_MS = 120;
const MAX_SNAPS = 30;

export class SnapBuffer {
  snaps: Snap[] = [];

  push(s: Snap): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && s.t <= last.t) return;
    this.snaps.push(s);
    if (this.snaps.length > MAX_SNAPS) this.snaps.shift();
  }

  /** Interpolated pose at render time `t` (ms). Holds the newest pose instead of extrapolating. */
  sample(t: number): Snap | null {
    const s = this.snaps;
    if (!s.length) return null;
    if (t <= s[0].t) return s[0];
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / (b.t - a.t || 1);
        return { t, p: lerp3(a.p, b.p, k), q: slerp(a.q, b.q, k) };
      }
    }
    return s[s.length - 1];
  }
}

export function lerp3(a: [number, number, number], b: [number, number, number], k: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function slerp(
  a: [number, number, number, number],
  b: [number, number, number, number],
  k: number,
): [number, number, number, number] {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (dot > 0.9995) {
    const r: [number, number, number, number] = [a[0] + (bx - a[0]) * k, a[1] + (by - a[1]) * k, a[2] + (bz - a[2]) * k, a[3] + (bw - a[3]) * k];
    const n = Math.hypot(...r) || 1;
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const th = Math.acos(dot);
  const s = Math.sin(th);
  const wa = Math.sin((1 - k) * th) / s;
  const wb = Math.sin(k * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}
