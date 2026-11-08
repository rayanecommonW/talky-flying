import { create } from "zustand";
import { LOCAL, type Dial, type StationCard } from "@dead-air/shared";

export type Phase = "start" | "connecting" | "flying" | "error";
export type RadioStatus = "idle" | "tuning" | "acquiring" | "connecting" | "live" | "off-air" | "no-signal";
export type Talker = { id: string; callsign: string; distance: number | null; host: boolean };

type GameState = {
  phase: Phase;
  error: string | null;
  callsign: string;
  sessionId: string;
  pilots: number;

  dial: Dial;
  /** The dial the radio is actually connected to (lags `dial` while turning the knob). */
  tunedDial: Dial | null;
  station: StationCard | null;
  radio: RadioStatus;
  /** Speech engine the station host is using right now ("local" | "elevenlabs"). */
  hostSpeech: string | null;
  presets: StationCard[];

  ptt: "off" | "requesting" | "on" | "busy";
  /** FM dial (string) -> sessionId holding the floor */
  floors: Record<string, string>;
  talkers: Talker[];
  inRange: number;

  /** No game server: solo flight, radio has no signal. */
  offline: boolean;
  settingsOpen: boolean;
  pointerLocked: boolean;
  throttle: number;
  speed: number;
  altitude: number;
  crashedAt: number;
  breakup: number;
  thirdPerson: boolean;
  showHelp: boolean;
  /** The fly-in from the sky after power-on is playing. */
  intro: boolean;
  guideOpen: boolean;
  landed: boolean;

  set: (p: Partial<GameState>) => void;
};

export const useGame = create<GameState>((set) => ({
  phase: "start",
  error: null,
  callsign: "",
  sessionId: "",
  pilots: 0,
  dial: LOCAL,
  tunedDial: null,
  station: null,
  radio: "idle",
  hostSpeech: null,
  presets: [],
  ptt: "off",
  floors: {},
  talkers: [],
  inRange: 0,
  offline: false,
  settingsOpen: false,
  pointerLocked: false,
  throttle: 0,
  speed: 0,
  altitude: 0,
  crashedAt: 0,
  breakup: 0,
  thirdPerson: false,
  showHelp: true,
  intro: false,
  guideOpen: false,
  landed: false,
  set: (p) => set(p),
}));

/** Someone else is transmitting on the frequency we're tuned to (FM is half-duplex). */
export function floorHeldByOther(s: { floors: Record<string, string>; dial: number; sessionId: string }): boolean {
  const holder = s.floors[String(s.dial)];
  return !!holder && holder !== s.sessionId;
}
