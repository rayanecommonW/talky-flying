/**
 * Drone flight model. Pure functions (no three.js) so it is unit-testable.
 * Angle mode: sticks set tilt, the drone self-levels and holds altitude at centre throttle.
 * Acro mode: sticks set rotation rates, nothing self-levels, throttle is raw thrust.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type Sticks = {
  /** -1..1: climb / descend (angle) or thrust offset (acro) */
  throttle: number;
  /** -1..1: positive = yaw right */
  yaw: number;
  /** -1..1: positive = nose down / forward */
  pitch: number;
  /** -1..1: positive = roll right */
  roll: number;
};

export type DroneState = {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  /** angle-mode attitude, radians */
  yawAngle: number;
  tilt: { pitch: number; roll: number };
};

export const G = 9.81;
const MAX_TILT = 0.62; // ~35 degrees
const TILT_RESPONSE = 7;
const YAW_RATE = 2.2;
const CLIMB_ACCEL = 14;
const DRAG = 0.22;
const VERTICAL_DAMP = 1.6;
const ACRO_RATE = 4.2;
const ACRO_THRUST = 2.1; // max thrust in g

export function initialState(pos: Vec3, yaw = 0): DroneState {
  return { pos: [...pos], vel: [0, 0, 0], quat: fromYawPitchRoll(yaw, 0, 0), yawAngle: yaw, tilt: { pitch: 0, roll: 0 } };
}

export function expo(x: number, e = 0.35): number {
  return x * (1 - e) + x * x * x * e;
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
export function step(s: DroneState, sticks: Sticks, dt: number, mode: "angle" | "acro"): { state: DroneState; move: Vec3 } {
  let quat: Quat;
  let yawAngle = s.yawAngle;
  let tilt = s.tilt;
  let thrust: number;

  if (mode === "angle") {
    yawAngle -= expo(sticks.yaw) * YAW_RATE * dt;
    const k = Math.min(1, dt * TILT_RESPONSE);
    tilt = {
      pitch: tilt.pitch + (expo(sticks.pitch) * MAX_TILT - tilt.pitch) * k,
      roll: tilt.roll + (expo(sticks.roll) * MAX_TILT - tilt.roll) * k,
    };
    quat = fromYawPitchRoll(yawAngle, tilt.pitch, tilt.roll);
    const up = rotate(quat, [0, 1, 0]);
    // Hover-compensated thrust: centre throttle holds altitude whatever the tilt.
    thrust = (G + sticks.throttle * CLIMB_ACCEL) / Math.max(up[1], 0.5);
  } else {
    const r = ACRO_RATE * dt;
    const dq = qmul(qmul(axisAngle([0, 1, 0], -expo(sticks.yaw) * r), axisAngle([1, 0, 0], -expo(sticks.pitch) * r)), axisAngle([0, 0, 1], -expo(sticks.roll) * r));
    quat = qnorm(qmul(s.quat, dq));
    thrust = G * (1 + sticks.throttle * (ACRO_THRUST - 1));
    // keep yawAngle roughly in sync so switching back to angle mode doesn't snap
    const fwd = rotate(quat, [0, 0, -1]);
    yawAngle = Math.atan2(-fwd[0], -fwd[2]);
    tilt = { pitch: 0, roll: 0 };
  }

  const up = rotate(quat, [0, 1, 0]);
  const acc: Vec3 = [
    up[0] * thrust - s.vel[0] * DRAG,
    up[1] * thrust - G - s.vel[1] * (mode === "angle" ? VERTICAL_DAMP : DRAG),
    up[2] * thrust - s.vel[2] * DRAG,
  ];
  const vel: Vec3 = [s.vel[0] + acc[0] * dt, s.vel[1] + acc[1] * dt, s.vel[2] + acc[2] * dt];
  const move: Vec3 = [vel[0] * dt, vel[1] * dt, vel[2] * dt];
  return { state: { pos: s.pos, vel, quat, yawAngle, tilt }, move };
}

export function speed(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
