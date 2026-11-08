/** Start on a station from the home-screen dial, then switch the host between Kokoro and ElevenLabs from Settings.
 * Spends a few hundred ElevenLabs characters. */
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 760 }, permissions: ["microphone"] })).newPage();
let ok = true;
const check = (name, pass, info = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} ${info}`);
  ok &&= pass;
};
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
};
await page.goto(process.env.WEB_URL ?? "http://localhost:5173");
await page.click(".glass-station:has-text('Port Ardent Rebuild News')");
await page.fill(".callsign-input", "SWIFT-3");
await page.click(".power-on");
await page.waitForSelector(".radio");
check("powers on tuned to the station picked on the dial", await waitFor(async () => (await page.locator(".freq").innerText()).includes("98.3"), 5000));
check("host on air", await waitFor(() => page.locator(".lamp.air.lit").count().then((n) => n > 0), 30000));

const openVoices = async () => {
  await page.click(".hud-settings");
  await page.click(".settings nav button:has-text('Station voices')");
};
await openVoices();
await page.click(".choice button:has-text('ElevenLabs')");
check("host switches to ElevenLabs", await waitFor(async () => (await page.locator(".note.now").innerText()).includes("ElevenLabs"), 8000));
await page.click(".nav-foot .close");
await page.waitForTimeout(12000); // let a couple of lines play on ElevenLabs
await openVoices();
await page.click(".choice button:has-text('Kokoro')");
check("host switches back to Kokoro", await waitFor(async () => (await page.locator(".note.now").innerText()).includes("Kokoro"), 8000));
await page.click(".nav-foot .close");
await browser.close();
process.exit(ok ? 0 : 1);
