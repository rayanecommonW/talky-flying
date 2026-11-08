/** FPV controls in the real game (FPV acro layout): punch out, dive forward, flip, flip upright, mouse pitch. */
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-angle=metal"] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 }, permissions: ["microphone"] })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => sessionStorage.getItem("fresh") || (localStorage.removeItem("deadair.settings"), sessionStorage.setItem("fresh", "1")));
await page.goto(process.env.WEB_URL ?? "http://localhost:5173");
await page.click(".start-settings");
await page.click(".choice button:has-text('FPV acro')");
await page.click(".nav-foot .close");
await page.fill(".callsign-input", "FALCON-7");
await page.click(".power-on");
await page.waitForSelector(".intro-card", { timeout: 60000 });
await page.waitForSelector(".intro-card", { state: "detached", timeout: 15000 });
await page.waitForTimeout(500);

const osd = async () => {
  const t = await page.locator(".top-right").innerText();
  return { speed: Number(t.match(/(\d+) KM\/H/)[1]), alt: Number(t.match(/ALT (-?\d+)/)[1]), thr: Number(t.match(/(\d+)%/)[1]), mode: t.split("\n")[0] };
};
let ok = true;
const check = (name, pass, info = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} ${info}`);
  ok &&= pass;
};

const start = await osd();
check("FPV layout is acro, throttle rests at hover", start.mode.startsWith("ACRO") && Math.abs(start.thr - 20) <= 2, JSON.stringify(start));

await page.keyboard.down("w");
await page.waitForTimeout(1000);
const punched = await osd();
await page.keyboard.up("w");
check("punch out: W climbs hard", punched.alt - start.alt > 8 && punched.thr > 90, `alt ${start.alt} -> ${punched.alt}, ${punched.speed} km/h`);
await page.waitForTimeout(1500);

// Tip the nose down with a quick pitch flick, then throttle up: fast forward flight.
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(180);
await page.keyboard.up("ArrowUp");
await page.keyboard.down("w");
await page.waitForTimeout(1600);
const fast = await osd();
await page.keyboard.up("w");
check("pitch forward + throttle = fast forward flight", fast.speed > 70, `${fast.speed} km/h`);

// Full roll: the drone goes upside down (acro has no self-levelling).
await page.keyboard.press("f");
await page.waitForTimeout(200);
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(400);
await page.keyboard.up("ArrowRight");
const upAfterRoll = await page.evaluate(() => window.__deadair.droneUp());
check("roll right flips the drone past 90 degrees", upAfterRoll < 0, `up.y=${upAfterRoll.toFixed(2)}`);
await page.keyboard.press("f");
await page.waitForTimeout(100);
const upAfterReset = await page.evaluate(() => window.__deadair.droneUp());
check("F flips it back upright", upAfterReset > 0.99, `up.y=${upAfterReset.toFixed(2)}`);

// Mouse: lock the pointer, move the mouse down, nose goes down.
await page.mouse.click(500, 300);
await page.waitForTimeout(300);
const locked = await page.evaluate(() => !!document.pointerLockElement);
if (locked) {
  const before = await page.evaluate(() => window.__deadair.droneFwd());
  for (let i = 0; i < 10; i++) await page.mouse.move(500, 300 + (i + 1) * 20);
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => window.__deadair.droneFwd());
  check("mouse down tips the nose down", after < before - 0.2, `fwd.y ${before.toFixed(2)} -> ${after.toFixed(2)}`);
} else console.log("SKIP  mouse pitch (no pointer lock in this browser)");

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(ok ? 0 : 1);
