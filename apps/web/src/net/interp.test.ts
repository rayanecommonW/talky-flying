import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapBuffer } from "./interp.ts";

test("interpolates between snapshots and holds the newest", () => {
  const b = new SnapBuffer();
  b.push({ t: 0, p: [0, 0, 0], q: [0, 0, 0, 1] });
  b.push({ t: 100, p: [10, 0, 0], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2] });
  const mid = b.sample(50)!;
  assert.ok(Math.abs(mid.p[0] - 5) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...mid.q) - 1) < 1e-9);
  assert.deepEqual(b.sample(500)!.p, [10, 0, 0]);
  assert.deepEqual(b.sample(-5)!.p, [0, 0, 0]);
});

test("ignores out-of-order snapshots", () => {
  const b = new SnapBuffer();
  b.push({ t: 100, p: [1, 0, 0], q: [0, 0, 0, 1] });
  b.push({ t: 50, p: [9, 9, 9], q: [0, 0, 0, 1] });
  assert.equal(b.snaps.length, 1);
});
