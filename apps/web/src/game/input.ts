/**
 * Keyboard + mouse + gamepad -> stick values and radio actions.
 * Keyboard: W/S pitch, A/D roll, mouse X or arrow keys yaw, Space/Shift climb/descend.
 * Gamepad (Mode 2, also EdgeTX/OpenTX radios in USB joystick mode): left stick throttle/yaw, right stick pitch/roll.
 */
import type { Sticks } from "./flight.ts";

const keys = new Set<string>();
let mouseYaw = 0;
let pointerLocked = false;

type Action = "ptt" | "tune+" | "tune-" | "band+" | "band-" | "local" | "mode" | "camera" | "help" | `preset${number}`;
type Listener = (action: Action, down: boolean) => void;
const listeners = new Set<Listener>();

export function onAction(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(a: Action, down: boolean) {
  for (const l of listeners) l(a, down);
}

const KEY_ACTIONS: Record<string, Action> = {
  KeyV: "ptt",
  Period: "tune+",
  Comma: "tune-",
  BracketRight: "band+",
  BracketLeft: "band-",
  KeyL: "local",
  KeyR: "mode",
  KeyC: "camera",
  KeyH: "help",
};

function isTyping(e: Event) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
}

export function installInput(canvas: HTMLElement): () => void {
  const down = (e: KeyboardEvent) => {
    if (isTyping(e)) return;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    const a = KEY_ACTIONS[e.code];
    if (a) emit(a, true);
    if (/^Digit[1-9]$/.test(e.code)) emit(`preset${Number(e.code.slice(5))}`, true);
  };
  const up = (e: KeyboardEvent) => {
    keys.delete(e.code);
    const a = KEY_ACTIONS[e.code];
    if (a) emit(a, false);
  };
  const blur = () => {
    if (keys.has("KeyV")) emit("ptt", false);
    keys.clear();
  };
  const move = (e: MouseEvent) => {
    if (pointerLocked) mouseYaw += e.movementX;
  };
  const wheel = (e: WheelEvent) => {
    emit(e.deltaY < 0 ? "tune+" : "tune-", true);
  };
  const mouseDown = (e: MouseEvent) => {
    if (e.button === 2) emit("ptt", true);
    else if (!pointerLocked) canvas.requestPointerLock?.();
  };
  const mouseUp = (e: MouseEvent) => {
    if (e.button === 2) emit("ptt", false);
  };
  const lockChange = () => {
    pointerLocked = document.pointerLockElement === canvas;
  };
  const noMenu = (e: Event) => e.preventDefault();

  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  window.addEventListener("mousemove", move);
  canvas.addEventListener("wheel", wheel, { passive: true });
  canvas.addEventListener("mousedown", mouseDown);
  window.addEventListener("mouseup", mouseUp);
  canvas.addEventListener("contextmenu", noMenu);
  document.addEventListener("pointerlockchange", lockChange);
  return () => {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
    window.removeEventListener("blur", blur);
    window.removeEventListener("mousemove", move);
    canvas.removeEventListener("wheel", wheel);
    canvas.removeEventListener("mousedown", mouseDown);
    window.removeEventListener("mouseup", mouseUp);
    canvas.removeEventListener("contextmenu", noMenu);
    document.removeEventListener("pointerlockchange", lockChange);
  };
}

const DEADZONE = 0.08;
const dz = (v: number) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
const axis = (neg: string[], pos: string[]) => (pos.some((k) => keys.has(k)) ? 1 : 0) - (neg.some((k) => keys.has(k)) ? 1 : 0);

const padButtons: boolean[] = [];
const PAD_ACTIONS: Record<number, Action> = { 0: "ptt", 7: "ptt", 5: "tune+", 4: "tune-", 3: "local", 2: "mode", 1: "camera" };

export function readSticks(dt: number): Sticks {
  const pad = navigator.getGamepads?.().find((p) => p && p.connected) ?? null;
  let throttle = axis(["ShiftLeft", "ShiftRight", "ArrowDown"], ["Space", "ArrowUp"]);
  let yaw = axis(["ArrowLeft", "KeyQ"], ["ArrowRight", "KeyE"]);
  let pitch = axis(["KeyS"], ["KeyW"]);
  let roll = axis(["KeyA"], ["KeyD"]);

  // mouse yaw: pixels per frame -> stick, decays immediately
  if (mouseYaw !== 0) {
    yaw = Math.max(-1, Math.min(1, yaw + (mouseYaw / Math.max(dt, 1 / 240)) * 0.0022));
    mouseYaw = 0;
  }

  if (pad) {
    const a = pad.axes;
    const t = dz(-(a[1] ?? 0));
    const y = dz(a[0] ?? 0);
    const p = dz(-(a[3] ?? 0));
    const r = dz(a[2] ?? 0);
    if (t || y || p || r) {
      throttle = t;
      yaw = y;
      pitch = p;
      roll = r;
    }
    pad.buttons.forEach((b, i) => {
      const was = padButtons[i] ?? false;
      if (b.pressed !== was) {
        padButtons[i] = b.pressed;
        const act = PAD_ACTIONS[i];
        if (act) emit(act, b.pressed);
      }
    });
  }
  return { throttle, yaw, pitch, roll };
}
