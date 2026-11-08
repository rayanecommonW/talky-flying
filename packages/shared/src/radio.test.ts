import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCAL, FM_MIN, FM_MAX, dialForRoom, dialLabel, roomForDial, stepDial, isValidDial } from "./radio.ts";

test("room names round-trip", () => {
  for (const d of [LOCAL, FM_MIN, 983, FM_MAX]) assert.equal(dialForRoom(roomForDial(d)), d);
  assert.equal(roomForDial(983), "fm-0983");
  assert.equal(dialForRoom("fm-0874"), null);
  assert.equal(dialForRoom("nope"), null);
});

test("labels", () => {
  assert.equal(dialLabel(983), "98.3");
  assert.equal(dialLabel(1080), "108.0");
  assert.equal(dialLabel(LOCAL), "LOCAL");
});

test("stepping wraps the band", () => {
  assert.equal(stepDial(FM_MAX, 1), FM_MIN);
  assert.equal(stepDial(FM_MIN, -1), FM_MAX);
  assert.equal(stepDial(LOCAL, 1), FM_MIN);
  assert.equal(stepDial(LOCAL, -1), FM_MAX);
  assert.equal(stepDial(900, 5), 905);
});

test("validation", () => {
  assert.ok(isValidDial(0));
  assert.ok(isValidDial(1000));
  assert.ok(!isValidDial(874));
  assert.ok(!isValidDial(98.3));
  assert.ok(!isValidDial("983"));
});
