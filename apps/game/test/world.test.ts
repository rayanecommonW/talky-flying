/**
 * Integration test against a running stack (game server + livekit-server).
 * GAME_URL defaults to http://localhost:2567.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, type Room } from "@colyseus/sdk";
import { WORLD_ROOM, LOCAL, type TunedMsg, type PttReplyMsg, type WelcomeMsg } from "@dead-air/shared";

const URL = process.env.GAME_URL ?? "http://localhost:2567";

function next<T>(room: Room, type: string, ms = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    const off = room.onMessage(type, (m: T) => {
      clearTimeout(timer);
      off();
      resolve(m);
    });
  });
}

async function pilot(callsign?: string) {
  const client = new Client(URL);
  const room = await client.joinOrCreate(WORLD_ROOM, { callsign });
  const welcome = await next<WelcomeMsg>(room, "welcome");
  // swallow messages we don't wait on
  for (const t of ["tuning", "respawn"]) room.onMessage(t, () => {});
  return { room, welcome };
}

test("join, tune, floor control, local open air", { timeout: 90_000 }, async () => {
  const a = await pilot("KESTREL-7");
  const b = await pilot("KESTREL-7"); // duplicate callsign gets a fresh one
  assert.equal(a.welcome.callsign, "KESTREL-7");
  assert.notEqual(b.welcome.callsign, "KESTREL-7");
  assert.equal(a.welcome.spawn.length, 3);

  // curated station
  a.room.send("tune", { dial: 983 });
  const ta = await next<TunedMsg>(a.room, "tuned");
  assert.equal(ta.room, "fm-0983");
  assert.equal(ta.station?.name, "Port Ardent Rebuild News");
  assert.ok(ta.token.split(".").length === 3, "LiveKit JWT");

  b.room.send("tune", { dial: 983 });
  await next<TunedMsg>(b.room, "tuned");

  // half-duplex: A takes the floor, B is busy, A releases, B gets it
  a.room.send("ptt", { down: true });
  assert.deepEqual(await next<PttReplyMsg>(a.room, "ptt"), { granted: true });
  b.room.send("ptt", { down: true });
  assert.deepEqual(await next<PttReplyMsg>(b.room, "ptt"), { granted: false, reason: "busy" });
  a.room.send("ptt", { down: false });
  await new Promise((r) => setTimeout(r, 150));
  b.room.send("ptt", { down: true });
  assert.deepEqual(await next<PttReplyMsg>(b.room, "ptt"), { granted: true });
  b.room.send("ptt", { down: false });

  // LOCAL is open air: both can key up at once
  a.room.send("tune", { dial: LOCAL });
  b.room.send("tune", { dial: LOCAL });
  const la = await next<TunedMsg>(a.room, "tuned");
  await next<TunedMsg>(b.room, "tuned");
  assert.equal(la.room, "local");
  assert.equal(la.station, null);
  a.room.send("ptt", { down: true });
  b.room.send("ptt", { down: true });
  assert.equal((await next<PttReplyMsg>(a.room, "ptt")).granted, true);
  assert.equal((await next<PttReplyMsg>(b.room, "ptt")).granted, true);

  // invalid dial is ignored (no reply), valid one after it still works
  a.room.send("tune", { dial: 98.3 });
  a.room.send("tune", { dial: 1045 });
  const t2 = await next<TunedMsg>(a.room, "tuned");
  assert.equal(t2.dial, 1045);

  // poses: plausible move accepted, teleport rejected
  const before = a.room.state.pilots.get(a.room.sessionId);
  const [x, y, z] = [before.x, before.y, before.z];
  a.room.send("pose", { p: [x + 1, y, z], q: [0, 0, 0, 1] });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a.room.state.pilots.get(a.room.sessionId).x, x + 1);
  a.room.send("pose", { p: [x + 5000, y, z], q: [0, 0, 0, 1] });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a.room.state.pilots.get(a.room.sessionId).x, x + 1);

  // world feed is visible to the radio agent
  const feed = await fetch(`${URL}/internal/world`, { headers: { authorization: "Bearer dev-internal-token" } }).then((r) => r.json());
  assert.equal(feed.pilots >= 2, true);
  const denied = await fetch(`${URL}/internal/world`);
  assert.equal(denied.status, 401);

  await a.room.leave();
  await b.room.leave();
});

test("an unclaimed frequency gets a generated station", { timeout: 60_000, skip: !process.env.TEST_GENERATION }, async () => {
  const a = await pilot();
  a.room.send("tune", { dial: 877 });
  const t = await next<TunedMsg>(a.room, "tuned", 45_000);
  assert.ok(t.station && t.station.name.length > 1);
  console.log("generated:", t.station);
  await a.room.leave();
});
