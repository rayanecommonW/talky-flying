/**
 * The dial is an integer in tenths of a MHz: 875..1080 is FM 87.5..108.0.
 * 0 is LOCAL: open-air proximity voice, not a frequency.
 */
export const LOCAL = 0;
export const FM_MIN = 875;
export const FM_MAX = 1080;
export const FM_STEP = 1;

export type Dial = number;

export function isFm(dial: Dial): boolean {
  return Number.isInteger(dial) && dial >= FM_MIN && dial <= FM_MAX;
}

export function isValidDial(dial: unknown): dial is Dial {
  return dial === LOCAL || (typeof dial === "number" && isFm(dial));
}

export function dialLabel(dial: Dial): string {
  return dial === LOCAL ? "LOCAL" : (dial / 10).toFixed(1);
}

/** LiveKit room name for a dial position. */
export function roomForDial(dial: Dial): string {
  return dial === LOCAL ? "local" : `fm-${String(dial).padStart(4, "0")}`;
}

export function dialForRoom(room: string): Dial | null {
  if (room === "local") return LOCAL;
  const m = /^fm-(\d{4})$/.exec(room);
  if (!m) return null;
  const dial = Number(m[1]);
  return isFm(dial) ? dial : null;
}

/** Step the dial, wrapping around the FM band. LOCAL steps onto the band edges. */
export function stepDial(dial: Dial, delta: number): Dial {
  if (dial === LOCAL) return delta >= 0 ? FM_MIN : FM_MAX;
  const span = FM_MAX - FM_MIN + 1;
  return FM_MIN + ((((dial - FM_MIN + delta) % span) + span) % span);
}

/** Proximity voice: subscribe inside ENTER, unsubscribe beyond EXIT (hysteresis). */
export const LOCAL_ENTER_RADIUS = 120;
export const LOCAL_EXIT_RADIUS = 145;
/** Longest single transmission before the floor is taken back. */
export const MAX_TX_MS = 30_000;
/** Server-side sanity cap on reported drone speed (m/s). */
export const MAX_DRONE_SPEED = 60;
