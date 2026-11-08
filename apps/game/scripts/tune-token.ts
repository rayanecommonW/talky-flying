/**
 * Test helper: join the world as a pilot, tune a dial, print the LiveKit grant as one JSON line,
 * then stay connected (as a listener) until stdin closes or the timeout passes.
 *   pnpm --filter @dead-air/game exec tsx scripts/tune-token.ts 983 [CALLSIGN] [seconds]
 */
import { Client } from "@colyseus/sdk";
import { WORLD_ROOM, type TunedMsg, type WelcomeMsg } from "@dead-air/shared";

const dial = Number(process.argv[2] ?? 983);
const callsign = process.argv[3] || undefined;
const seconds = Number(process.argv[4] ?? 120);
const client = new Client(process.env.GAME_URL ?? "http://localhost:2567");
const room = await client.joinOrCreate(WORLD_ROOM, { callsign });
room.onMessage("tuning", () => {});
room.onMessage("ptt", () => {});
const welcome = await new Promise<WelcomeMsg>((r) => room.onMessage("welcome", r));
room.onMessage("tuned", (t: TunedMsg) => {
  console.log(JSON.stringify({ ...t, callsign: welcome.callsign, sessionId: welcome.sessionId, livekitUrl: welcome.livekitUrl }));
});
room.send("tune", { dial });
process.stdin.on("data", (d) => {
  const cmd = d.toString().trim();
  if (cmd === "ptt-down") room.send("ptt", { down: true });
  if (cmd === "ptt-up") room.send("ptt", { down: false });
});
process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(0), seconds * 1000);
