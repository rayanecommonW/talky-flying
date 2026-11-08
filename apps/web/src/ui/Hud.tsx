import { dialLabel, FM_MAX, FM_MIN, isFm, LOCAL } from "@dead-air/shared";
import { floorHeldByOther, useGame } from "../state/store.ts";

const STATUS_TEXT: Record<string, string> = {
  idle: "",
  tuning: "TUNING",
  acquiring: "SIGNAL ACQUIRING",
  connecting: "LOCKING",
  live: "",
  "off-air": "OFF AIR",
};

function DialScale({ dial }: { dial: number }) {
  const pct = isFm(dial) ? ((dial - FM_MIN) / (FM_MAX - FM_MIN)) * 100 : -4;
  const ticks = [];
  for (let f = 88; f <= 106; f += 2) {
    ticks.push(
      <div key={f} className="tick" style={{ left: `${((f * 10 - FM_MIN) / (FM_MAX - FM_MIN)) * 100}%` }}>
        <span>{f}</span>
      </div>,
    );
  }
  return (
    <div className="scale">
      <div className={`local-mark ${dial === LOCAL ? "on" : ""}`}>LOCAL</div>
      <div className="band">
        {ticks}
        <div className="needle" style={{ left: `${pct}%`, opacity: dial === LOCAL ? 0 : 1 }} />
      </div>
    </div>
  );
}

function Signal({ level }: { level: number }) {
  return (
    <div className="signal" title="signal">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={i < level ? "lit" : ""} style={{ height: `${6 + i * 4}px` }} />
      ))}
    </div>
  );
}

export function Hud() {
  const g = useGame();
  const fm = isFm(g.dial);
  const signal = g.radio === "live" ? (fm ? 4 : Math.min(5, 1 + g.inRange)) : g.radio === "off-air" ? 1 : g.radio === "connecting" ? 2 : 0;
  const status = STATUS_TEXT[g.radio] ?? "";
  const crashed = performance.now() - g.crashedAt < 1400;

  return (
    <div className="hud">
      <div className="osd top-left">
        <div className="callsign">{g.callsign}</div>
        <div className="small">PORT ARDENT · {g.pilots} PILOT{g.pilots === 1 ? "" : "S"} AIRBORNE</div>
      </div>
      <div className="osd top-right">
        <div>
          {g.mode === "angle" ? "ANGLE" : "ACRO"} {g.thirdPerson ? "· CHASE" : ""}
        </div>
        <div className="small">
          {Math.round(g.speed * 3.6)} KM/H · ALT {Math.round(g.altitude)} M
        </div>
      </div>
      <div className="crosshair" />
      {crashed && <div className="signal-lost">SIGNAL LOST</div>}

      {g.talkers.length > 0 && (
        <div className="talkers">
          {g.talkers.map((t) => (
            <div key={t.id} className={t.host ? "host" : ""}>
              ◉ {t.host ? (g.station?.host ?? "HOST") : t.callsign}
            </div>
          ))}
        </div>
      )}

      <div className="radio">
        <div className="radio-top">
          <div className="lcd">
            <div className="freq">
              {g.dial === LOCAL ? "LOCAL" : dialLabel(g.dial)}
              {fm && <span className="unit">MHz</span>}
            </div>
            <div className="station">
              {status ? (
                <span className="blink">{status}…</span>
              ) : fm ? (
                g.station?.name ?? "—"
              ) : (
                `OPEN AIR · ${g.inRange} IN RANGE`
              )}
            </div>
            <div className="host">
              {fm && g.station ? (
                <>
                  {g.station.host} · <span className="slogan">{g.station.slogan}</span>
                </>
              ) : (
                !fm && "Proximity voice. Pilots near you, where they are."
              )}
            </div>
          </div>
          <div className="lamps">
            <div className={`lamp tx ${g.ptt === "on" ? "lit" : ""}`}>TX</div>
            <div className={`lamp rx ${g.talkers.length ? "lit" : ""}`}>RX</div>
            <div className={`lamp busy ${floorHeldByOther(g) || g.ptt === "busy" ? "lit" : ""}`}>BUSY</div>
            <div className={`lamp air ${fm && g.radio === "live" ? "lit" : ""}`}>ON AIR</div>
            <Signal level={signal} />
          </div>
        </div>
        <DialScale dial={g.dial} />
        <div className="presets">
          {g.presets.map((p, i) => (
            <span key={p.dial} className={p.dial === g.dial ? "on" : ""}>
              {i + 1} {dialLabel(p.dial)}
            </span>
          ))}
        </div>
      </div>

      {g.showHelp && (
        <div className="help">
          <b>FLY</b> W/S pitch · A/D roll · mouse or ←/→ yaw · SPACE/SHIFT climb/descend · R angle/acro · C chase cam
          <br />
          <b>RADIO</b> hold V or right mouse to talk · wheel or , . tune 0.1 · [ ] tune 1.0 · L local ⇄ FM · 1–9 presets · H hide
          <br />
          <span className="dim">Gamepad: Mode 2 sticks · A/RT talk · LB/RB tune · Y local · X mode</span>
        </div>
      )}
    </div>
  );
}
