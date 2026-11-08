import { test } from "node:test";
import assert from "node:assert/strict";
import { actualRate, DEFAULT_PARAMS, fromYawPitchRoll, hoverThrottle, initialState, rotate, settle, step, upright, type DroneState, type FlightParams, type Sticks } from "./flight.ts";

const ANGLE: FlightParams = { ...DEFAULT_PARAMS, mode: "angle" };
const ACRO: FlightParams = { ...DEFAULT_PARAMS, mode: "acro" };
const idle = (p: FlightParams): Sticks => ({ throttle: hoverThrottle(p), yaw: 0, pitch: 0, roll: 0 });

function fly(s: DroneState, sticks: Sticks, secs: number, p: FlightParams) {
  const dt = 1 / 120;
  for (let i = 0; i < secs / dt; i++) {
    const r = step(s, sticks, dt, p);
    s = { ...r.state, pos: [s.pos[0] + r.move[0], s.pos[1] + r.move[1], s.pos[2] + r.move[2]] };
  }
  return s;
}

test("actual rates: centre sensitivity, full-stick max, symmetric", () => {
  const r = { center: 200, max: 700, expo: 0.5 };
  assert.equal(actualRate(0, r), 0);
  assert.ok(Math.abs(actualRate(1, r) - 700) < 1e-9);
  assert.ok(Math.abs(actualRate(-1, r) + 700) < 1e-9);
  assert.ok(actualRate(0.1, r) < 25, "soft around centre");
});

test("angle mode hovers at centre throttle", () => {
  const s = fly(initialState([0, 30, 0]), idle(ANGLE), 3, ANGLE);
  assert.ok(Math.abs(s.pos[1] - 30) < 0.01, `altitude drifted to ${s.pos[1]}`);
  assert.ok(Math.hypot(s.vel[0], s.vel[2]) < 0.01);
});

test("acro hovers at hover throttle when level", () => {
  const s = fly(initialState([0, 30, 0]), idle(ACRO), 3, ACRO);
  assert.ok(Math.abs(s.pos[1] - 30) < 0.01, `altitude drifted to ${s.pos[1]}`);
});

test("angle: pitch forward flies toward -Z and keeps altitude", () => {
  const s = fly(initialState([0, 30, 0]), { ...idle(ANGLE), pitch: 1 }, 4, ANGLE);
  assert.ok(s.pos[2] < -30, `only reached z=${s.pos[2]}`);
  assert.ok(Math.abs(s.pos[1] - 30) < 1.5, `altitude ${s.pos[1]}`);
});

test("angle: roll right strafes toward +X", () => {
  const s = fly(initialState([0, 30, 0]), { ...idle(ANGLE), roll: 1 }, 3, ANGLE);
  assert.ok(s.pos[0] > 15, `x=${s.pos[0]}`);
});

test("acro punch: full throttle climbs > 3 g net", () => {
  const s = fly(initialState([0, 30, 0]), { ...idle(ACRO), throttle: 1 }, 0.5, ACRO);
  assert.ok(s.vel[1] > 15, `vy=${s.vel[1]}`);
});

test("acro: full roll stick does a complete flip in about half a second", () => {
  const s = fly(initialState([0, 100, 0]), { ...idle(ACRO), roll: 1 }, 0.25, ACRO);
  const up = rotate(s.quat, [0, 1, 0]);
  assert.ok(up[1] < -0.5, `upside down after 0.25s at 720 deg/s, up=${up}`);
});

test("acro: no self-levelling, and top speed is bounded by drag", () => {
  const tilted = fly(initialState([0, 100, 0]), { ...idle(ACRO), pitch: 0.5 }, 0.2, ACRO);
  const held = fly(tilted, idle(ACRO), 1, ACRO);
  assert.ok(rotate(held.quat, [0, 1, 0])[1] < 0.95, "stays tilted without stick input");
  const fast = fly(tilted, { ...idle(ACRO), throttle: 1 }, 15, ACRO);
  const v = Math.hypot(...fast.vel);
  assert.ok(v > 70 && v < 100, `top speed ${v} m/s`);
});

test("gravity is heavier than Earth: cut the throttle and it drops fast", () => {
  const s = fly(initialState([0, 100, 0]), { ...idle(ACRO), throttle: 0 }, 0.5, ACRO);
  assert.ok(s.vel[1] < -6.5, `vy=${s.vel[1]}`);
});

test("angle: climbing doesn't add forward push (throttle is climb rate only)", () => {
  const cruise = fly(initialState([0, 30, 0]), { ...idle(ANGLE), pitch: 1 }, 2, ANGLE);
  const climbing = fly(initialState([0, 30, 0]), { ...idle(ANGLE), pitch: 1, throttle: 1 }, 2, ANGLE);
  assert.ok(Math.abs(climbing.pos[2] - cruise.pos[2]) < 0.5, `cruise z=${cruise.pos[2]} climbing z=${climbing.pos[2]}`);
  assert.ok(climbing.pos[1] > 50, `climbed to ${climbing.pos[1]}`);
  const top = fly(initialState([0, 30, 0]), { ...idle(ANGLE), pitch: 1 }, 15, ANGLE);
  const v = Math.hypot(top.vel[0], top.vel[2]);
  assert.ok(v > 42 && v < 60, `angle top speed ${v} m/s`);
});

test("settle levels a landed drone onto its gear and stops it", () => {
  let s = { ...initialState([0, 0.2, 0], 0.7), quat: fromYawPitchRoll(0.7, 0.4, -0.3), vel: [3, -2, 1] as [number, number, number] };
  for (let i = 0; i < 30; i++) s = settle(s, 1 / 60);
  assert.ok(rotate(s.quat, [0, 1, 0])[1] > 0.999);
  assert.equal(Math.hypot(...s.vel), 0);
});

test("yaw right turns the nose clockwise seen from above", () => {
  for (const p of [ANGLE, ACRO]) {
    const s = fly(initialState([0, 30, 0]), { ...idle(p), yaw: 1 }, 0.3, p);
    assert.ok(rotate(s.quat, [0, 0, -1])[0] > 0.3, p.mode);
  }
});

test("mouse rotation is applied directly in body frame", () => {
  const s0 = initialState([0, 30, 0]);
  const { state } = step(s0, idle(ACRO), 1 / 60, ACRO, { pitch: Math.PI / 2, roll: 0, yaw: 0 });
  const fwd = rotate(state.quat, [0, 0, -1]);
  assert.ok(fwd[1] < -0.99, `nose straight down, fwd=${fwd}`);
});

test("upright levels the drone and keeps heading", () => {
  const flipped = fly(initialState([0, 100, 0], 1), { ...idle(ACRO), roll: 1 }, 0.25, ACRO);
  const u = upright(flipped);
  assert.ok(rotate(u.quat, [0, 1, 0])[1] > 0.999);
});
