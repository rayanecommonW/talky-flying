/**
 * Browser end-to-end: two pilots with fake microphones in headless Chromium.
 * Needs the local stack (livekit-server, game, radio worker, speech) and `vite` on :5173.
 *   node e2e/two-pilots.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const URL = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = new globalThis.URL("../../../logs/e2e/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const STARTED = Date.now();
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${new globalThis.URL("./caller.wav", import.meta.url).pathname}`, "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

async function pilot(callsign) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, permissions: ["microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${callsign} pageerror]`, e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`[${callsign} console]`, m.text().slice(0, 200)));
  await page.goto(URL);
  await page.fill(".callsign-input", callsign);
  await page.click(".power-on");
  await page.waitForSelector(".radio", { timeout: 20_000 });
  return page;
}

const text = (page, sel) => page.locator(sel).first().innerText().catch(() => "");
const lit = (page, cls) => page.locator(`.lamp.${cls}.lit`).count().then((n) => n > 0);
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}
async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

const a = await pilot("HERON-1");
const b = await pilot("WREN-2");
// The server hands out a different callsign if one is still held by a reconnecting session.
const A = (await text(a, ".callsign")).trim();
console.log(`pilots: ${A} and ${(await text(b, ".callsign")).trim()}`);

// 1. both in the world, both on LOCAL
check("A sees two pilots", await waitFor(async () => Number((await text(a, ".top-left .small")).match(/(\d+) PILOT/)?.[1] ?? 0) >= 2, 8000));
check("A starts on LOCAL", (await text(a, ".freq")).startsWith("LOCAL"));
check("canvas renders", (await a.locator("canvas").count()) === 1);
await a.waitForTimeout(1500);
await a.screenshot({ path: `${OUT}a-local.png` });

// 2. proximity voice: A keys up on LOCAL, B hears it (RX lamp + talker list)
await waitFor(async () => (await text(b, ".station")).includes("1 IN RANGE"), 6000);
const inRange = await text(b, ".station");
await a.keyboard.down("v");
const heard = await waitFor(async () => (await lit(b, "rx")) && (await text(b, ".talkers")).includes(A), 8000);
check("A transmits on LOCAL (TX lamp)", await lit(a, "tx"));
check("B hears A on LOCAL", heard, inRange);
await b.screenshot({ path: `${OUT}b-hears-a.png` });
await a.keyboard.up("v");

// 3. flying changes speed/altitude
const before = await text(a, ".top-right .small");
await holdKey(a, "w", 1500);
await holdKey(a, "Space", 800);
const after = await text(a, ".top-right .small");
check("A flies", before !== after, `${before} -> ${after}`);

// 4. A tunes to a station: preset 2 (89.7 Belfry Free Radio); the host comes on air
await a.keyboard.press("2");
const onAir = await waitFor(() => lit(a, "air"), 25_000);
check("A tuned to FM, host on air", onAir, `${await text(a, ".freq")} ${await text(a, ".station")}`);
const hostTalking = await waitFor(async () => (await text(a, ".talkers")).length > 0, 25_000);
check("A hears the host talking (RX)", hostTalking, await text(a, ".talkers"));
await a.screenshot({ path: `${OUT}a-fm.png` });

// 5. trade-off: B on LOCAL no longer hears A when A keys up on FM
await a.keyboard.down("v");
check("A gets the floor on FM", await waitFor(() => lit(a, "tx"), 4000));
await b.waitForTimeout(1500);
check("B on LOCAL does not hear A (A is on FM)", !(await lit(b, "rx")) || !(await text(b, ".talkers")).includes(A));

// 6. half-duplex: B tunes to the same frequency and is busy while A holds the floor
await b.keyboard.press("2");
await waitFor(() => lit(b, "air"), 25_000);
check("B sees BUSY while A holds the floor", await waitFor(() => lit(b, "busy"), 4000));
await b.keyboard.down("v");
await b.waitForTimeout(800);
check("B is refused the floor", !(await lit(b, "tx")));
await b.keyboard.up("v");
await a.waitForTimeout(1500);
await a.keyboard.up("v");
check("floor released", await waitFor(async () => !(await lit(b, "busy")), 4000));

// 7. the host answers the caller (the fake mic plays e2e/caller.wav, a question about pigeons)
const GAME = process.env.GAME_URL ?? "http://localhost:2567";
const dial = Math.round(Number(await text(a, ".freq").then((t) => t.replace("MHz", ""))) * 10);
const transcript = async () =>
  (await fetch(`${GAME}/internal/show/${dial}`, { headers: { authorization: "Bearer dev-internal-token" } }).then((r) => r.json())).transcript.filter(
    (t) => t.t >= STARTED,
  );
const heardCaller = await waitFor(async () => (await transcript()).some((t) => t.speaker === A), 20_000, 500);
const rows = await transcript();
const callIdx = rows.findLastIndex((t) => t.speaker === A);
check("host transcribed the caller", heardCaller, rows[callIdx]?.text);
const replied = callIdx >= 0 && await waitFor(async () => (await transcript()).slice(callIdx + 1).some((t) => t.speaker !== A), 20_000, 500);
check("host answered the caller on air", replied, (await transcript()).slice(callIdx + 1, callIdx + 3).map((t) => t.text).join(" / ").slice(0, 200));
await b.screenshot({ path: `${OUT}b-fm.png` });

// 8. back to LOCAL with L
await a.keyboard.press("l");
check("L returns to LOCAL", await waitFor(async () => (await text(a, ".freq")).startsWith("LOCAL"), 3000));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
