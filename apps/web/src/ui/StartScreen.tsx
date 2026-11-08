import { useEffect, useState } from "react";
import { dialLabel, FM_MAX, FM_MIN, LOCAL, randomCallsign, type Dial, type StationCard } from "@dead-air/shared";
import { powerOn } from "../net/session.ts";
import { fetchStations } from "../net/world.ts";
import { useGame } from "../state/store.ts";
import { CURATED } from "./curated.ts";

/** Position on the glass, leaving room on the right for the slanted station names. */
const pct = (dial: number) => 3 + ((dial - FM_MIN) / (FM_MAX - FM_MIN)) * 84;

/** The radio's glass dial: every curated station printed at its frequency. Click one to start there. */
function GlassDial({ stations, dial, onPick }: { stations: StationCard[]; dial: Dial; onPick: (d: Dial) => void }) {
  const ticks = [];
  for (let f = 88; f <= 106; f += 2) ticks.push(f);
  return (
    <div className="glass">
      <button type="button" className={`glass-local ${dial === LOCAL ? "on" : ""}`} onClick={() => onPick(LOCAL)}>
        Local
      </button>
      <div className="glass-band">
        {stations.map((s) => (
          <button
            type="button"
            key={s.dial}
            className={`glass-station ${s.dial === dial ? "on" : ""}`}
            style={{ left: `${pct(s.dial)}%` }}
            onClick={() => onPick(s.dial)}
            title={`${dialLabel(s.dial)} ${s.name}`}
          >
            <span>{s.name}</span>
          </button>
        ))}
        <div className="glass-scale">
          {ticks.map((f) => (
            <i key={f} style={{ left: `${pct(f * 10)}%` }}>
              {f}
            </i>
          ))}
        </div>
        <div className="glass-needle" style={{ left: dial === LOCAL ? "-3%" : `${pct(dial)}%` }} />
      </div>
    </div>
  );
}

export function StartScreen({ onSettings }: { onSettings: () => void }) {
  const { phase, error } = useGame();
  const [callsign, setCallsign] = useState(() => localStorage.getItem("deadair.callsign") ?? randomCallsign());
  const [stations, setStations] = useState<StationCard[]>(CURATED);
  const [dial, setDial] = useState<Dial>(LOCAL);
  const busy = phase === "connecting";

  useEffect(() => {
    void fetchStations().then((live) => {
      const curated = live.filter((s) => s.curated);
      if (curated.length) setStations(curated);
    });
  }, []);

  const picked = stations.find((s) => s.dial === dial);

  return (
    <div className="start">
      <header className="start-head">
        <h1>Dead Air</h1>
        <p>Port Ardent, two winters after the front moved on.</p>
        <button type="button" className="start-settings" onClick={onSettings}>
          Settings
        </button>
      </header>

      <form
        className="set"
        onSubmit={(e) => {
          e.preventDefault();
          void powerOn(callsign.trim().toUpperCase(), dial);
        }}
      >
        <GlassDial stations={stations} dial={dial} onPick={setDial} />
        <div className="set-row">
          <div className="set-copy">
            {dial === LOCAL ? (
              <p>
                You fly a drone over a broken city with one radio. <strong>Local</strong> is open air: hold the key and the pilots near you hear
                you, from where you are. Every frequency from 87.5 to 108.0 is a call-in show. Key up there and you're on the air.
              </p>
            ) : (
              <p>
                <strong>
                  {dialLabel(dial)} · {picked?.name}
                </strong>
                <br />
                {picked?.host} hosts. “{picked?.slogan}” You'll power on tuned here; hold the talk key to call in.
              </p>
            )}
          </div>
          <label className="set-callsign">
            <span>Callsign</span>
            <input
              className="callsign-input"
              value={callsign}
              onChange={(e) => setCallsign(e.target.value.toUpperCase())}
              maxLength={13}
              spellCheck={false}
              aria-label="Callsign"
            />
          </label>
          <button className="power-on" disabled={busy}>
            <span className={`valve ${busy ? "warm" : ""}`} />
            {busy ? "Warming up" : "Power on"}
          </button>
        </div>
        {error && <div className="set-error">{error}</div>}
        <div className="set-fine">Headphones help. The microphone is only live while you hold the talk key. Station hosts are AI.</div>
      </form>
    </div>
  );
}
