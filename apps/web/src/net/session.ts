import { isCallsign, LOCAL } from "@dead-air/shared";
import { startAudio, setStatic } from "../audio/engine.ts";
import { useGame } from "../state/store.ts";
import { Radio } from "./radio.ts";
import { Voice } from "./voice.ts";
import { fetchStations, World } from "./world.ts";

/** Everything that lives for the whole flight: world connection, voice, radio. */
export const session = {
  world: new World(),
  voice: null as unknown as Voice,
  radio: null as unknown as Radio,
  spawn: [0, 40, 0] as [number, number, number],
  /** Live world positions of remote pilots, keyed by sessionId (= LiveKit identity). */
  positions: new Map<string, [number, number, number]>(),
  respawnListeners: new Set<(spawn: [number, number, number]) => void>(),
};

if (import.meta.env.DEV) (window as unknown as { __deadair: typeof session }).__deadair = session;

export async function powerOn(requestedCallsign: string): Promise<void> {
  const set = useGame.getState().set;
  set({ phase: "connecting", error: null });
  try {
    await startAudio();
    setStatic(0.5, 50);
    session.voice = new Voice({
      onHostPresent: (present, name) => session.radio.onHostPresent(present, name),
      onSpeakers: (ids) => {
        const pilots = session.world.pilots;
        set({
          talkers: ids.map((id) => ({
            id,
            callsign: pilots.get(id)?.callsign ?? (id.startsWith("agent-") ? "HOST" : id),
            distance: null,
            host: id.startsWith("agent-"),
          })),
        });
      },
      onDisconnected: () => session.radio.onVoiceDropped(),
    });
    session.radio = new Radio(session.world, session.voice);
    const micOk = await session.voice.initMic();
    if (!micOk) console.warn("[session] flying without a microphone: you can listen but not transmit");

    const welcome = await session.world.connect(isCallsign(requestedCallsign) ? requestedCallsign : undefined, {
      onTuned: (m) => void session.radio.onTuned(m),
      onTuning: (m) => session.radio.onTuning(m.dial),
      onPtt: (m) => session.radio.onPttReply(m),
      onRespawn: (spawn) => {
        session.spawn = spawn;
        for (const l of session.respawnListeners) l(spawn);
      },
      onFloor: (floors) => set({ floors: Object.fromEntries(floors) }),
      onLeave: () => set({ phase: "error", error: "Lost the connection to Port Ardent." }),
    });
    localStorage.setItem("deadair.callsign", welcome.callsign);
    session.spawn = welcome.spawn;
    set({ callsign: welcome.callsign, sessionId: welcome.sessionId, presets: (await fetchStations()).filter((s) => s.curated).slice(0, 9) });
    set({ phase: "flying" });
    session.radio.turn(LOCAL);
  } catch (e) {
    console.error(e);
    set({ phase: "error", error: `Could not reach the game server (${(e as Error).message}).` });
  }
}
