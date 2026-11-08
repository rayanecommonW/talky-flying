/**
 * Keyboard + mouse + gamepad -> stick values and radio actions, driven by the bindings in settings.
 * Mouse moves rotate the drone directly (like mouse-look, but on the drone's own axes) while the
 * pointer is locked. Gamepads and USB RC radios (EdgeTX/OpenTX joystick mode) map as Mode 1 or 2.
 */
import { hoverThrottle, type MouseRot, type Sticks } from "./flight.ts";
import { settings, useSettings, type BindAction, type ButtonAction } from "../state/settings.ts";
import { useGame } from "../state/store.ts";

export type Action = ButtonAction | `preset${number}`;
type Listener = (action: Action, down: boolean) => void;

const held = new Set<BindAction>();
const listeners = new Set<Listener>();
let codeMap = new Map<string, BindAction[]>();
let capture: ((code: string) => void) | null = null;
let mouseDx = 0;
let mouseDy = 0;
let pointerLocked = false;

function rebuildCodeMap() {
  const m = new Map<string, BindAction[]>();
  for (const [action, codes] of Object.entries(settings().bindings) as [BindAction, string[]][]) {
    for (const c of codes) m.set(c, [...(m.get(c) ?? []), action]);
  }
  codeMap = m;
}
rebuildCodeMap();
useSettings.subscribe((s, prev) => {
  if (s.bindings !== prev.bindings) rebuildCodeMap();
});

export function onAction(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(a: Action, down: boolean) {
  for (const l of listeners) l(a, down);
}

const BUTTONS = new Set<string>(["ptt", "tuneUp", "tuneDown", "bandUp", "bandDown", "local", "mode", "camera", "reset", "help", "settings"]);

/** The next key pressed goes to `fn` instead of the game (used by the rebinding UI). */
export function captureNextKey(fn: ((code: string) => void) | null): void {
  capture = fn;
}

function isTyping(e: Event) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

export function isPointerLocked(): boolean {
  return pointerLocked;
}

/** Global listeners, installed once at startup so the menus can use bindings too. */
export function installInput(): void {
  window.addEventListener("keydown", (e) => {
    if (capture) {
      e.preventDefault();
      const fn = capture;
      capture = null;
      fn(e.code);
      return;
    }
    if (isTyping(e)) return;
    const actions = codeMap.get(e.code) ?? [];
    if (actions.length || ["Space", "Tab"].includes(e.code) || e.code.startsWith("Arrow")) e.preventDefault();
    if (e.repeat) return;
    const menuOpen = useGame.getState().settingsOpen;
    for (const a of actions) {
      if (menuOpen && a !== "settings") continue;
      held.add(a);
      if (BUTTONS.has(a)) emit(a as ButtonAction, true);
    }
    if (!menuOpen && /^Digit[1-9]$/.test(e.code)) emit(`preset${Number(e.code.slice(5))}`, true);
  });
  window.addEventListener("keyup", (e) => {
    for (const a of codeMap.get(e.code) ?? []) {
      held.delete(a);
      if (BUTTONS.has(a)) emit(a as ButtonAction, false);
    }
  });
  window.addEventListener("blur", releaseAll);
  window.addEventListener("mousemove", (e) => {
    if (!pointerLocked) return;
    mouseDx += e.movementX;
    mouseDy += e.movementY;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 2) emit("ptt", false);
  });
  document.addEventListener("pointerlockchange", () => {
    pointerLocked = !!document.pointerLockElement;
    useGame.getState().set({ pointerLocked });
  });
}

export function releaseAll(): void {
  if (held.has("ptt")) emit("ptt", false);
  held.clear();
}

/** Canvas-only listeners: wheel tunes, right button talks, left click grabs the mouse. */
export function installCanvasInput(canvas: HTMLElement): () => void {
  const wheel = (e: WheelEvent) => emit(e.deltaY < 0 ? "tuneUp" : "tuneDown", true);
  const mouseDown = (e: MouseEvent) => {
    if (e.button === 2) emit("ptt", true);
    else if (!pointerLocked) lockPointer(canvas);
  };
  const noMenu = (e: Event) => e.preventDefault();
  canvas.addEventListener("wheel", wheel, { passive: true });
  canvas.addEventListener("mousedown", mouseDown);
  canvas.addEventListener("contextmenu", noMenu);
  return () => {
    canvas.removeEventListener("wheel", wheel);
    canvas.removeEventListener("mousedown", mouseDown);
    canvas.removeEventListener("contextmenu", noMenu);
  };
}

export function lockPointer(el?: HTMLElement | null): void {
  const target = el ?? document.querySelector("canvas");
  (target?.requestPointerLock as (() => Promise<void> | void) | undefined)?.call(target)?.catch?.(() => {});
}

export function unlockPointer(): void {
  if (document.pointerLockElement) document.exitPointerLock();
}

// ---------- sticks ----------

const DEADZONE = 0.06;
const dz = (v: number) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
const pair = (neg: BindAction, pos: BindAction) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
const approach = (v: number, target: number, rate: number) =>
  v < target ? Math.min(target, v + rate) : Math.max(target, v - rate);

/** Keys are on/off; ramp them like a thumb on a stick so flips and turns can be feathered. */
const KEY_STICK_RATE = 5; // full deflection in 0.2 s
const kb = { yaw: 0, pitch: 0, roll: 0 };
let throttle = -1; // -1 = not initialised yet
const padButtons: boolean[] = [];
const PAD_ACTIONS: Record<number, ButtonAction> = { 0: "ptt", 7: "ptt", 5: "tuneUp", 4: "tuneDown", 3: "local", 2: "mode", 1: "camera", 9: "settings", 8: "reset" };

/** Throttle back to hover and keyboard sticks to centre (spawn, respawn, flip upright, mode switch). */
export function resetSticks(): void {
  throttle = -1;
  kb.yaw = kb.pitch = kb.roll = 0;
}

export function readSticks(dt: number): Sticks {
  const s = settings();
  const hover = hoverThrottle(s);
  if (throttle < 0) throttle = hover;

  kb.yaw = approach(kb.yaw, pair("yawLeft", "yawRight"), KEY_STICK_RATE * dt);
  kb.pitch = approach(kb.pitch, pair("pitchBack", "pitchForward"), KEY_STICK_RATE * dt);
  kb.roll = approach(kb.roll, pair("rollLeft", "rollRight"), KEY_STICK_RATE * dt);
  const t = pair("throttleDown", "throttleUp");
  if (s.throttleKeys === "spring") {
    const target = t > 0 ? 1 : t < 0 ? 0 : hover;
    throttle = approach(throttle, target, (t === 0 ? 3 : 2.2) * dt);
  } else {
    throttle = Math.max(0, Math.min(1, throttle + t * 0.8 * dt));
  }
  const out: Sticks = { throttle, yaw: kb.yaw, pitch: kb.pitch, roll: kb.roll };

  const pad = navigator.getGamepads?.().find((p) => p && p.connected) ?? null;
  if (pad) {
    const a = pad.axes;
    const [ly, lx, ry, rx] = [-(a[1] ?? 0), a[0] ?? 0, -(a[3] ?? 0), a[2] ?? 0];
    const thr = s.padMode === 2 ? ly : ry;
    const pitch = dz(s.padMode === 2 ? ry : ly);
    const yaw = dz(lx);
    const roll = dz(rx);
    const padThrottle =
      s.padThrottle === "radio" ? (thr + 1) / 2 : thr >= 0 ? hover + dz(thr) * (1 - hover) : hover + dz(thr) * hover;
    // The pad takes over as soon as any stick moves; keyboard keeps working when the pad is idle.
    if (pitch || yaw || roll || (s.padThrottle === "radio" ? Math.abs(padThrottle - hover) > 0.02 : dz(thr) !== 0)) {
      out.pitch = pitch;
      out.yaw = yaw;
      out.roll = roll;
      out.throttle = padThrottle;
      throttle = padThrottle;
    }
    pad.buttons.forEach((b, i) => {
      if (b.pressed !== (padButtons[i] ?? false)) {
        padButtons[i] = b.pressed;
        const act = PAD_ACTIONS[i];
        if (act) emit(act, b.pressed);
      }
    });
  }
  return out;
}

/** Mouse movement since the last frame as a direct rotation, radians. */
export function readMouse(): MouseRot {
  const s = settings();
  const k = (s.mouseSens * Math.PI) / 180;
  const dx = mouseDx * k;
  const dy = mouseDy * k * (s.invertMouseY ? -1 : 1);
  mouseDx = 0;
  mouseDy = 0;
  // Mouse down = nose down, like looking down.
  return {
    pitch: s.mouseY === "pitch" ? dy : 0,
    roll: s.mouseX === "roll" ? dx : 0,
    yaw: s.mouseX === "yaw" ? dx : 0,
  };
}
