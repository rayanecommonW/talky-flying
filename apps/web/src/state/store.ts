import { create } from "zustand";
import { LOCAL, type Dial, type StationCard } from "@dead-air/shared";

export type Phase = "start" | "connecting" | "flying" | "error";
export type RadioStatus = "idle" | "tuning" | "acquiring" | "connecting" | "live" | "off-air";
export type FlightMode = "angle" | "acro";
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
  presets: StationCard[];

  ptt: "off" | "requesting" | "on" | "busy";
  /** FM dial (string) -> sessionId holding the floor */
  floors: Record<string, string>;
  talkers: Talker[];
  inRange: number;

  mode: FlightMode;
  speed: number;
  altitude: number;
  crashedAt: number;
  breakup: number;
  thirdPerson: boolean;
  showHelp: boolean;

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
  presets: [],
  ptt: "off",
  floors: {},
  talkers: [],
  inRange: 0,
  mode: "angle",
  speed: 0,
  altitude: 0,
  crashedAt: 0,
  breakup: 0,
  thirdPerson: false,
  showHelp: true,
  set: (p) => set(p),
}));

/** Someone else is transmitting on the frequency we're tuned to (FM is half-duplex). */
export function floorHeldByOther(s: { floors: Record<string, string>; dial: number; sessionId: string }): boolean {
  const holder = s.floors[String(s.dial)];
  return !!holder && holder !== s.sessionId;
}
