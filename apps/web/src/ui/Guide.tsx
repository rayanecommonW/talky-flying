import { useEffect, useState, type ReactNode } from "react";
import { dialLabel, LOCAL, type Dial, type StationCard } from "@dead-air/shared";
import { session } from "../net/session.ts";
import { fetchStations } from "../net/world.ts";
import { keyName, useSettings } from "../state/settings.ts";
import { useGame } from "../state/store.ts";
import { CURATED } from "./curated.ts";

/** What you get when you call each kind of show. */
const FORMAT_NOTE: Record<string, string> = {
  dispatch: "Civil defence notices. Call in to report a crash or a hazard.",
  "call-in": "Open phone lines. Key up and say anything.",
  conspiracy: "Theories about the city. Bring one of your own.",
  sports: "Live commentary on whoever is racing around town.",
  advice: "Talk your troubles through with the host.",
  news: "Rebuild headlines. Call in with news from where you're flying.",
  "music-pirate": "A DJ with no records. Request a song anyway.",
  classifieds: "Buy, sell, swap. Call in with an offer.",
  traffic: "Where the pilots are and who just crashed.",
  "late-night": "Slow talk for whoever is still awake.",
};

function Entry({ dial, now, title, freq, children }: { dial: Dial; now: boolean; title: string; freq: string; children: ReactNode }) {
  return (
    <button type="button" className={`guide-entry ${now ? "now" : ""}`} onClick={() => session.radio.turn(dial)}>
      <span className="guide-freq">{freq}</span>
      <span className="guide-body">
        <b>{title}</b>
        {children}
      </span>
    </button>
  );
}

/** The printed station log: every show on the dial, what it does, click to tune. */
export function StationGuide() {
  const dial = useGame((s) => s.dial);
  const offline = useGame((s) => s.offline);
  const set = useGame((s) => s.set);
  const key = useSettings((s) => keyName(s.bindings.guide[0] ?? "KeyB"));
  const [stations, setStations] = useState<StationCard[]>(CURATED);

  useEffect(() => {
    void fetchStations().then((live) => live.length && setStations(live));
  }, []);

  const curated = stations.filter((s) => s.curated).sort((a, b) => a.dial - b.dial);
  const found = stations.filter((s) => !s.curated).sort((a, b) => a.dial - b.dial);

  return (
    <aside className="guide" aria-label="Station guide">
      <header>
        <h2>Station guide</h2>
        <button type="button" onClick={() => set({ guideOpen: false })}>
          Close <kbd>{key}</kbd>
        </button>
      </header>
      {offline && <p className="guide-note">No game server: the dial is dead air right now.</p>}
      <p className="guide-note">
        Every host is chasing the same story: what Verity did, and who helped. Call in with what you've found, or ask for an escort and up to
        five drones will follow you.
      </p>
      <div className="guide-list">
        <Entry dial={LOCAL} now={dial === LOCAL} title="Local" freq="LOCAL">
          <small>Open air. Pilots near you hear you, from where you are.</small>
        </Entry>
        {curated.map((s) => (
          <Entry key={s.dial} dial={s.dial} now={dial === s.dial} title={s.name.replace(/\s*\d{2,3}\.\d$/, "")} freq={dialLabel(s.dial)}>
            <small>
              {s.host} · {s.format}
              {s.listeners > 0 && ` · ${s.listeners} listening`}
            </small>
            <span className="guide-what">{FORMAT_NOTE[s.format] ?? "Call-in show. Key up and you're on the air."}</span>
          </Entry>
        ))}
        {found.length > 0 && <h3>Picked up on the dial</h3>}
        {found.map((s) => (
          <Entry key={s.dial} dial={s.dial} now={dial === s.dial} title={s.name.replace(/^\d{2,3}\.\d\s*/, "")} freq={dialLabel(s.dial)}>
            <small>
              {s.host} · {s.format}
            </small>
          </Entry>
        ))}
      </div>
      <p className="guide-note">Every other frequency from 87.5 to 108.0 is live too. Tune anywhere and a show signs on.</p>
    </aside>
  );
}
