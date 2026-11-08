import type { Dial } from "./radio.ts";
import type { StationCard } from "./station.ts";

export const WORLD_ROOM = "world";
/** Escort drones a radio host can send to follow one pilot. */
export const MAX_ESCORTS = 5;

/** Client -> server */
export type PoseMsg = { p: [number, number, number]; q: [number, number, number, number] };
export type TuneMsg = { dial: Dial };
export type PttMsg = { down: boolean };
export type CrashMsg = { speed: number };

/** Server -> client */
export type WelcomeMsg = { sessionId: string; callsign: string; livekitUrl: string; spawn: [number, number, number] };
export type TunedMsg = {
  dial: Dial;
  room: string;
  token: string;
  station: StationCard | null;
};
export type TuningMsg = { dial: Dial; status: "generating" };
export type PttReplyMsg = { granted: boolean; reason?: "busy" | "timeout" | "not-tuned" };

export type JoinOptions = { callsign?: string };

/** GET /api/world: the feed radio hosts read. */
export type WorldFeed = {
  city: string;
  pilots: number;
  /** Escort drones flying with pilots right now. */
  escorts?: number;
  listenersByDial: Record<string, number>;
  hotspots: { landmark: string; pilots: string[] }[];
  recentEvents: { t: number; kind: "crash" | "join" | "leave"; callsign: string; landmark: string | null }[];
};
