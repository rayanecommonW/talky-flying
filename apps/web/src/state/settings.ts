/**
 * Player settings: key bindings, mouse and gamepad mapping, flight tuning, audio levels and
 * which speech engine the AI stations use. Persisted to localStorage.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Rates } from "../game/flight.ts";

export type FlightMode = "acro" | "angle";
export type Layout = "fpv" | "arcade";

/** Bindable keyboard actions. Values are KeyboardEvent.code strings. */
export const AXIS_ACTIONS = ["throttleUp", "throttleDown", "pitchForward", "pitchBack", "rollLeft", "rollRight", "yawLeft", "yawRight"] as const;
export const BUTTON_ACTIONS = ["ptt", "tuneUp", "tuneDown", "bandUp", "bandDown", "local", "mode", "camera", "reset", "guide", "help", "settings"] as const;
export type AxisAction = (typeof AXIS_ACTIONS)[number];
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];
export type BindAction = AxisAction | ButtonAction;
export type Bindings = Record<BindAction, string[]>;

export const ACTION_LABEL: Record<BindAction, string> = {
  throttleUp: "Throttle up",
  throttleDown: "Throttle down",
  pitchForward: "Pitch forward",
  pitchBack: "Pitch back",
  rollLeft: "Roll left",
  rollRight: "Roll right",
  yawLeft: "Yaw left",
  yawRight: "Yaw right",
  ptt: "Talk (hold)",
  tuneUp: "Tune up 0.1",
  tuneDown: "Tune down 0.1",
  bandUp: "Tune up 1.0",
  bandDown: "Tune down 1.0",
  local: "Local / FM",
  mode: "Acro / angle mode",
  camera: "Chase camera",
  reset: "Flip upright",
  guide: "Station guide",
  help: "Show controls",
  settings: "Settings",
};

const COMMON: Pick<Bindings, ButtonAction> = {
  ptt: ["KeyV"],
  tuneUp: ["Period"],
  tuneDown: ["Comma"],
  bandUp: ["BracketRight"],
  bandDown: ["BracketLeft"],
  local: ["KeyL"],
  mode: ["KeyR"],
  camera: ["KeyC"],
  reset: ["KeyF"],
  guide: ["KeyB"],
  help: ["KeyH"],
  settings: ["KeyP", "Escape"],
};

export const LAYOUTS: Record<Layout, { bindings: Bindings; mouseX: Settings["mouseX"]; mouseY: Settings["mouseY"]; mode: FlightMode; throttleKeys: Settings["throttleKeys"] }> = {
  // Mouse-aim: the mouse looks around, W/S fly along where you look, A/D slide, Space/Shift go up and
  // down. The default.
  arcade: {
    bindings: {
      pitchForward: ["KeyW", "ArrowUp"],
      pitchBack: ["KeyS", "ArrowDown"],
      rollLeft: ["KeyA"],
      rollRight: ["KeyD"],
      yawLeft: ["KeyQ", "ArrowLeft"],
      yawRight: ["KeyE", "ArrowRight"],
      throttleUp: ["Space"],
      throttleDown: ["ShiftLeft"],
      ...COMMON,
    },
    mouseX: "yaw",
    mouseY: "pitch",
    mode: "angle",
    throttleKeys: "spring",
  },
  // Acro, nothing levels itself: W/S throttle, A/D roll, Q/E yaw, the mouse steers (yaw and pitch).
  fpv: {
    bindings: {
      throttleUp: ["KeyW"],
      throttleDown: ["KeyS"],
      rollLeft: ["KeyA", "ArrowLeft"],
      rollRight: ["KeyD", "ArrowRight"],
      yawLeft: ["KeyQ"],
      yawRight: ["KeyE"],
      pitchForward: ["ArrowUp"],
      pitchBack: ["ArrowDown"],
      ...COMMON,
    },
    mouseX: "yaw",
    mouseY: "pitch",
    mode: "acro",
    throttleKeys: "spring",
  },
};

export type Settings = {
  layout: Layout | "custom";
  bindings: Bindings;
  /** What horizontal / vertical mouse movement does. */
  mouseX: "roll" | "yaw" | "off";
  mouseY: "pitch" | "off";
  invertMouseY: boolean;
  /** Degrees of rotation per pixel of mouse movement. */
  mouseSens: number;
  /** spring: throttle returns to hover when no key is held. ramp: keys move the throttle and it stays put. */
  throttleKeys: "spring" | "ramp";
  /** centered: gamepad throttle stick springs to centre (= hover). radio: non-centring RC throttle, bottom = 0. */
  padThrottle: "centered" | "radio";
  padMode: 1 | 2;

  mode: FlightMode;
  rates: Rates;
  yawRates: Rates;
  /** Thrust-to-weight ratio. Freestyle quads sit around 5-8. */
  twr: number;
  /** Max tilt in angle mode, degrees. */
  angleMaxTilt: number;
  /** m/s². */
  gravity: number;
  /** FPV camera uptilt in acro, degrees. */
  cameraTilt: number;
  /** Horizontal field of view, degrees. */
  fov: number;

  volMaster: number;
  volVoice: number;
  volStatic: number;
  volTones: number;

  /** Which speech engine AI stations use while you're listening. */
  speech: "local" | "elevenlabs";
};

export const DEFAULT_SETTINGS: Settings = {
  layout: "arcade",
  ...LAYOUTS.arcade,
  invertMouseY: false,
  mouseSens: 0.12,
  padThrottle: "centered",
  padMode: 2,
  rates: { center: 220, max: 720, expo: 0.45 },
  yawRates: { center: 160, max: 480, expo: 0.3 },
  twr: 5,
  angleMaxTilt: 60,
  gravity: 1.6 * 9.81,
  cameraTilt: 20,
  fov: 120,
  volMaster: 0.8,
  volVoice: 1,
  volStatic: 0.2,
  volTones: 0.5,
  speech: "local",
};

type SettingsStore = Settings & {
  set: (p: Partial<Settings>) => void;
  applyLayout: (l: Layout) => void;
  bind: (action: BindAction, code: string, slot: number) => void;
  reset: () => void;
};

export const useSettings = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      set: (p) => set(p),
      applyLayout: (l) => set({ layout: l, ...structuredClone(LAYOUTS[l]) }),
      /** Put `code` in slot 0/1 of `action`, removing it from any other action so one key never does two things. */
      bind: (action, code, slot) => {
        const b = structuredClone(get().bindings);
        for (const k of Object.keys(b) as BindAction[]) b[k] = b[k].filter((c) => c !== code);
        const keys = b[action];
        if (code) keys[slot] = code;
        else keys.splice(slot, 1);
        b[action] = keys.filter(Boolean);
        set({ bindings: b, layout: "custom" });
      },
      reset: () => set(structuredClone(DEFAULT_SETTINGS)),
    }),
    {
      name: "deadair.settings",
      version: 3,
      // v2 changed the layouts, flight tuning and defaults: keep only levels and personal preferences.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<Settings>;
        if (version === 2) {
          // v3: Simple became mouse-aim (mouse looks up and down too), a tighter FOV, quieter static.
          const v3: Partial<Settings> = { fov: DEFAULT_SETTINGS.fov, volStatic: Math.min(p.volStatic ?? 0.2, 0.2) };
          return p.layout === "arcade" || !p.layout ? { ...p, ...v3, ...structuredClone(LAYOUTS.arcade) } : { ...p, ...v3 };
        }
        if (version >= 3) return p;
        const keep: (keyof Settings)[] = ["volMaster", "volVoice", "volStatic", "volTones", "speech", "mouseSens", "invertMouseY", "padMode", "padThrottle"];
        return Object.fromEntries(keep.filter((k) => k in p).map((k) => [k, p[k]]));
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Settings>;
        return { ...current, ...p, bindings: { ...current.bindings, ...(p.bindings ?? {}) } };
      },
    },
  ),
);

export const settings = () => useSettings.getState();

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  ShiftLeft: "L Shift",
  ShiftRight: "R Shift",
  ControlLeft: "L Ctrl",
  ControlRight: "R Ctrl",
  AltLeft: "L Alt",
  AltRight: "R Alt",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Period: ".",
  Comma: ",",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Slash: "/",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Bksp",
  CapsLock: "Caps",
};

/** "KeyW" -> "W", "Digit3" -> "3", "ArrowUp" -> "↑" */
export function keyName(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}
