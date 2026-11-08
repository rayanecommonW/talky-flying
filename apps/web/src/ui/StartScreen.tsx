import { useState } from "react";
import { randomCallsign } from "@dead-air/shared";
import { powerOn } from "../net/session.ts";
import { useGame } from "../state/store.ts";

export function StartScreen() {
  const { phase, error } = useGame();
  const [callsign, setCallsign] = useState(() => localStorage.getItem("deadair.callsign") ?? randomCallsign());
  const busy = phase === "connecting";
  return (
    <div className="start">
      <div className="start-card">
        <div className="brand">DEAD AIR</div>
        <div className="tag">Port Ardent · two winters after the front moved on</div>
        <p>
          You fly a drone over a broken city. Your radio has one dial. <b>LOCAL</b> is open air: the pilots around you, where they are.
          Every frequency from <b>87.5 to 108.0</b> is a station somebody runs from a basement or a bell tower. Hold the key and you are on
          the air. You cannot listen to both.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void powerOn(callsign.trim().toUpperCase());
          }}
        >
          <label>
            CALLSIGN
            <input value={callsign} onChange={(e) => setCallsign(e.target.value.toUpperCase())} maxLength={13} spellCheck={false} />
          </label>
          <button disabled={busy}>{busy ? "WARMING VALVES…" : "POWER ON"}</button>
        </form>
        {error && <div className="error">{error}</div>}
        <div className="fine">Headphones recommended. Microphone needed to transmit. Voices from the AI stations are generated.</div>
      </div>
    </div>
  );
}
