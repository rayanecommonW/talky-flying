/** Collision check against the Blender city: dive to the ground, then fly into buildings until a crash.
 * Uses the default Simple layout (self-levelling, Shift descends, W flies forward) so the descent is gentle. */
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-angle=metal"] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 }, permissions: ["microphone"] })).newPage();
await page.goto(process.env.WEB_URL ?? "http://localhost:5173");
await page.fill(".callsign-input", "ROOK-6");
await page.click(".power-on");
await page.waitForSelector(".intro-card", { timeout: 60000 });
await page.waitForSelector(".intro-card", { state: "detached", timeout: 15000 });
await page.waitForTimeout(500);
const alt = async () => Number((await page.locator(".top-right .small").innerText()).match(/ALT (-?\d+)/)[1]);
let ok = true;
await page.keyboard.down("Shift");
await page.waitForTimeout(7000);
const floor = await alt();
await page.keyboard.up("Shift");
console.log(`${floor > -3 ? "PASS" : "FAIL"}  descending stops on the ground/roofs (alt ${floor} m)`);
ok &&= floor > -3;
await page.waitForTimeout(1000);
const sitting = await page.locator(".top-right .small").innerText();
console.log(`${sitting.includes("LANDED") ? "PASS" : "FAIL"}  it lands and stays down after letting go (${sitting})`);
ok &&= sitting.includes("LANDED");
await page.keyboard.down("Space"); await page.waitForTimeout(800); await page.keyboard.up("Space");
const lifted = await page.locator(".top-right .small").innerText();
console.log(`${!lifted.includes("LANDED") && (await alt()) > floor + 3 ? "PASS" : "FAIL"}  Space takes off again (${lifted})`);
ok &&= !lifted.includes("LANDED");
let crashed = false;
for (let i = 0; i < 4 && !crashed; i++) {
  await page.keyboard.down("w");
  const end = Date.now() + 9000;
  while (Date.now() < end && !crashed) {
    crashed = (await page.locator(".signal-lost").count()) > 0;
    await page.waitForTimeout(100);
  }
  await page.keyboard.up("w");
  await page.keyboard.down("ArrowRight"); await page.waitForTimeout(500); await page.keyboard.up("ArrowRight");
}
console.log(`${crashed ? "PASS" : "FAIL"}  flying low into buildings crashes (SIGNAL LOST)`);
ok &&= crashed;
await page.waitForTimeout(2500);
const after = await alt();
console.log(`${after > 20 ? "PASS" : "FAIL"}  respawned at altitude (${after} m)`);
ok &&= after > 20;
await browser.close();
process.exit(ok ? 0 : 1);
