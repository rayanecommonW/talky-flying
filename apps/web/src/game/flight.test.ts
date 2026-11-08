import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, rotate, step, type DroneState } from "./flight.ts";

const idle = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };

function fly(s: DroneState, sticks = idle, secs = 3, mode: "angle" | "acro" = "angle") {
  const dt = 1 / 60;
  for (let i = 0; i < secs / dt; i++) {
    const r = step(s, sticks, dt, mode);
    s = { ...r.state, pos: [s.pos[0] + r.move[0], s.pos[1] + r.move[1], s.pos[2] + r.move[2]] };
  }
  return s;
}

test("angle mode hovers at centre throttle", () => {
  const s = fly(initialState([0, 30, 0]));
  assert.ok(Math.abs(s.pos[1] - 30) < 0.01, `altitude drifted to ${s.pos[1]}`);
  assert.ok(Math.hypot(s.vel[0], s.vel[2]) < 0.01);
});

test("pitch forward flies toward -Z and keeps altitude", () => {
  const s = fly(initialState([0, 30, 0]), { ...idle, pitch: 1 }, 4);
  assert.ok(s.pos[2] < -20, `only reached z=${s.pos[2]}`);
  assert.ok(Math.abs(s.pos[1] - 30) < 1, `altitude ${s.pos[1]}`);
});

test("roll right strafes toward +X", () => {
  const s = fly(initialState([0, 30, 0]), { ...idle, roll: 1 }, 3);
  assert.ok(s.pos[0] > 10, `x=${s.pos[0]}`);
});

test("throttle climbs and descends", () => {
  assert.ok(fly(initialState([0, 30, 0]), { ...idle, throttle: 1 }, 2).pos[1] > 40);
  assert.ok(fly(initialState([0, 30, 0]), { ...idle, throttle: -1 }, 2).pos[1] < 20);
});

test("yaw right turns the nose clockwise seen from above", () => {
  const s = fly(initialState([0, 30, 0]), { ...idle, yaw: 1 }, 0.5);
  const fwd = rotate(s.quat, [0, 0, -1]);
  assert.ok(fwd[0] > 0.3, `forward ${fwd}`);
});

test("acro: no self-levelling, and top speed is bounded by drag", () => {
  const s = fly(initialState([0, 100, 0]), { ...idle, pitch: 1 }, 0.15, "acro");
  const tilted = fly(s, { ...idle, throttle: 0.6 }, 1, "acro");
  const up = rotate(tilted.quat, [0, 1, 0]);
  assert.ok(up[1] < 0.95, "stays tilted without stick input");
  const fast = fly(initialState([0, 100, 0]), { ...idle, pitch: 1 }, 20);
  assert.ok(Math.hypot(...fast.vel) < 40, `ran away to ${Math.hypot(...fast.vel)}`);
});
