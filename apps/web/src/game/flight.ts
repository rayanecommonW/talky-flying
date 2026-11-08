/**
 * Drone flight model. Pure functions (no three.js) so it is unit-testable.
 *
 * Acro (rate) mode, like a real FPV quad: sticks command rotation rates (Betaflight "actual"
 * rates), nothing self-levels, throttle is raw thrust along the drone's up axis, and thrust-to-weight
 * is high, so the drone flips, punches out and carries momentum.
 * Angle mode: sticks command tilt, the drone self-levels and centre throttle holds altitude.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type Sticks = {
  /** 0..1, raw stick position */
  throttle: number;
  /** -1..1: positive = yaw right */
  yaw: number;
  /** -1..1: positive = nose down / forward */
  pitch: number;
  /** -1..1: positive = roll right */
  roll: number;
};

/** Betaflight "actual" rates: deg/s at centre, deg/s at full stick, expo 0..1. */
export type Rates = { center: number; max: number; expo: number };

export type FlightParams = {
  mode: "angle" | "acro";
  twr: number;
  rates: Rates;
  yawRates: Rates;
  /** degrees */
  angleMaxTilt: number;
};

/** Direct rotation from the mouse this frame, radians, body frame (same signs as Sticks). */
export type MouseRot = { pitch: number; roll: number; yaw: number };

export type DroneState = {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  /** body rotation rate, rad/s: pitch, yaw, roll (acro) */
  rate: Vec3;
  /** angle-mode attitude, radians */
  yawAngle: number;
  tilt: { pitch: number; roll: number };
  /** angle mode: tilt the mouse is holding, decays back to level */
  mouseTilt: number;
};

export const G = 9.81;
const DEG = Math.PI / 180;
const RATE_RESPONSE = 30; // 1/s, how fast the quad reaches the commanded rate (~35 ms)
const TILT_RESPONSE = 10;
const LIN_DRAG = 0.05;
const QUAD_DRAG = 0.022;
const ANGLE_VERTICAL_DAMP = 1.6;

export const DEFAULT_PARAMS: FlightParams = {
  mode: "acro",
  twr: 5,
  rates: { center: 220, max: 720, expo: 0.45 },
  yawRates: { center: 160, max: 480, expo: 0.3 },
  angleMaxTilt: 55,
};

export function initialState(pos: Vec3, yaw = 0): DroneState {
  return { pos: [...pos], vel: [0, 0, 0], quat: fromYawPitchRoll(yaw, 0, 0), rate: [0, 0, 0], yawAngle: yaw, tilt: { pitch: 0, roll: 0 }, mouseTilt: 0 };
}

/** Throttle stick position that holds altitude when level. */
export function hoverThrottle(p: Pick<FlightParams, "mode" | "twr">): number {
  return p.mode === "angle" ? 0.5 : 1 / p.twr;
}

/** Stick (-1..1) to rotation rate in deg/s, Betaflight "actual" rates. */
export function actualRate(x: number, r: Rates): number {
  const a = Math.min(1, Math.abs(x));
  const expoed = a * (a ** 5 * r.expo + a * (1 - r.expo));
  return Math.sign(x) * (a * r.center + Math.max(0, r.max - r.center) * expoed);
}

// --- tiny quaternion helpers (x, y, z, w), three.js conventions: Y up, -Z forward ---

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qnorm(q: Quat): Quat {
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function axisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Yaw about world Y, then pitch about local X (positive = nose down), then roll about local Z (positive = right). */
export function fromYawPitchRoll(yaw: number, pitch: number, roll: number): Quat {
  const qy = axisAngle([0, 1, 0], yaw);
  const qx = axisAngle([1, 0, 0], -pitch);
  const qz = axisAngle([0, 0, 1], -roll);
  return qnorm(qmul(qmul(qy, qx), qz));
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/** Advance the drone by dt seconds. Returns the desired displacement; collision is resolved by the caller. */
export function step(
  s: DroneState,
  sticks: Sticks,
  dt: number,
  p: FlightParams = DEFAULT_PARAMS,
  mouse: MouseRot = { pitch: 0, roll: 0, yaw: 0 },
): { state: DroneState; move: Vec3 } {
  let quat: Quat;
  let yawAngle = s.yawAngle;
  let tilt = s.tilt;
  let rate = s.rate;
  let mouseTilt = s.mouseTilt;
  let thrust: number;
  const maxThrust = p.twr * G;

  if (p.mode === "angle") {
    // Mouse: horizontal turns the drone (roll would only self-level away), vertical leans it.
    yawAngle -= actualRate(sticks.yaw, p.yawRates) * DEG * dt + mouse.yaw + mouse.roll;
    const max = p.angleMaxTilt * DEG;
    mouseTilt = Math.max(-max, Math.min(max, (mouseTilt + mouse.pitch) * Math.exp(-3 * dt)));
    const k = Math.min(1, dt * TILT_RESPONSE);
    const target = { pitch: Math.max(-max, Math.min(max, sticks.pitch * max + mouseTilt)), roll: sticks.roll * max };
    tilt = { pitch: tilt.pitch + (target.pitch - tilt.pitch) * k, roll: tilt.roll + (target.roll - tilt.roll) * k };
    quat = fromYawPitchRoll(yawAngle, tilt.pitch, tilt.roll);
    const up = rotate(quat, [0, 1, 0]);
    // Centre throttle holds altitude whatever the tilt; full stick climbs hard.
    const climb = (sticks.throttle - 0.5) * 2 * (p.twr - 1) * G * 0.6;
    thrust = Math.min(maxThrust, (G + climb) / Math.max(up[1], 0.4));
    rate = [0, 0, 0];
  } else {
    const k = Math.min(1, dt * RATE_RESPONSE);
    const target: Vec3 = [actualRate(sticks.pitch, p.rates) * DEG, actualRate(sticks.yaw, p.yawRates) * DEG, actualRate(sticks.roll, p.rates) * DEG];
    rate = [rate[0] + (target[0] - rate[0]) * k, rate[1] + (target[1] - rate[1]) * k, rate[2] + (target[2] - rate[2]) * k];
    const ax = -(rate[0] * dt + mouse.pitch);
    const ay = -(rate[1] * dt + mouse.yaw);
    const az = -(rate[2] * dt + mouse.roll);
    const dq = qmul(qmul(axisAngle([0, 1, 0], ay), axisAngle([1, 0, 0], ax)), axisAngle([0, 0, 1], az));
    quat = qnorm(qmul(s.quat, dq));
    thrust = Math.max(0, Math.min(1, sticks.throttle)) * maxThrust;
    // keep the angle-mode attitude in sync so switching modes doesn't snap
    const fwd = rotate(quat, [0, 0, -1]);
    yawAngle = Math.atan2(-fwd[0], -fwd[2]);
    tilt = { pitch: 0, roll: 0 };
    mouseTilt = 0;
  }

  const up = rotate(quat, [0, 1, 0]);
  const v = s.vel;
  const sp = Math.hypot(v[0], v[1], v[2]);
  const drag = LIN_DRAG + QUAD_DRAG * sp;
  const vdrag = p.mode === "angle" ? Math.max(drag, ANGLE_VERTICAL_DAMP) : drag;
  const acc: Vec3 = [up[0] * thrust - v[0] * drag, up[1] * thrust - G - v[1] * vdrag, up[2] * thrust - v[2] * drag];
  const vel: Vec3 = [v[0] + acc[0] * dt, v[1] + acc[1] * dt, v[2] + acc[2] * dt];
  const move: Vec3 = [vel[0] * dt, vel[1] * dt, vel[2] * dt];
  return { state: { pos: s.pos, vel, quat, rate, yawAngle, tilt, mouseTilt }, move };
}

/** Level the drone keeping its heading (the "flip upright" key / turtle mode). */
export function upright(s: DroneState): DroneState {
  const fwd = rotate(s.quat, [0, 0, -1]);
  const yaw = Math.abs(fwd[1]) > 0.98 ? s.yawAngle : Math.atan2(-fwd[0], -fwd[2]);
  return { ...s, quat: fromYawPitchRoll(yaw, 0, 0), rate: [0, 0, 0], yawAngle: yaw, tilt: { pitch: 0, roll: 0 }, mouseTilt: 0, vel: [0, 0, 0] };
}

export function speed(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
