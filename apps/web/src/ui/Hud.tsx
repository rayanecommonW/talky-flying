import type { ReactNode } from "react";
import { dialLabel, FM_MAX, FM_MIN, isFm, LOCAL } from "@dead-air/shared";
import { keyName, useSettings, type BindAction } from "../state/settings.ts";
import { floorHeldByOther, useGame } from "../state/store.ts";

const STATUS_TEXT: Record<string, string> = {
  idle: "",
  tuning: "TUNING",
  acquiring: "SIGNAL ACQUIRING",
  connecting: "LOCKING",
  live: "",
  "off-air": "OFF AIR",
  "no-signal": "",
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

/** Keys for an action as small keycaps, straight from the current bindings. */
function Keys({ a, extra }: { a: BindAction | BindAction[]; extra?: string }) {
  const bindings = useSettings((s) => s.bindings);
  const codes = (Array.isArray(a) ? a : [a]).map((x) => bindings[x][0]).filter(Boolean);
  return (
    <span className="keys">
      {codes.map((c, i) => (
        <kbd key={i}>{keyName(c)}</kbd>
      ))}
      {extra && <em>{extra}</em>}
    </span>
  );
}

function HelpLine({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="help-line">
      {k}
      <span>{children}</span>
    </div>
  );
}

/** Controls reference, split by hand: flying on the left, the radio on the right. */
function Help() {
  const s = useSettings();
  const set = useGame((g) => g.set);
  const guideOpen = useGame((g) => g.guideOpen);
  const angle = s.mode === "angle";
  const mouse = angle
    ? "look around, fly where you look"
    : [s.mouseY === "pitch" ? "pitch" : "", s.mouseX === "yaw" ? "turn" : s.mouseX === "roll" ? "roll" : ""].filter(Boolean).join(" + ");
  return (
    <>
      <aside className="help help-left">
        <header>
          <b>Flying</b> <span>{s.mode === "acro" ? "acro" : "self-level"}</span>
        </header>
        <HelpLine k={<Keys a={["pitchForward", "pitchBack"]} />}>{angle ? "fly forward / back" : "pitch"}</HelpLine>
        <HelpLine k={<Keys a={["rollLeft", "rollRight"]} />}>{angle ? "slide left / right" : "roll"}</HelpLine>
        <HelpLine k={<Keys a={["throttleUp", "throttleDown"]} />}>{angle ? "up / down" : "throttle"}</HelpLine>
        <HelpLine k={<Keys a={["yawLeft", "yawRight"]} />}>{angle ? "turn" : "yaw"}</HelpLine>
        {mouse && (
          <HelpLine
            k={
              <span className="keys">
                <em>mouse</em>
              </span>
            }
          >
            {mouse}
          </HelpLine>
        )}
        <HelpLine k={<Keys a="mode" />}>{s.mode === "acro" ? "self-level mode" : "acro mode"}</HelpLine>
        <HelpLine k={<Keys a="reset" />}>flip upright</HelpLine>
        <HelpLine k={<Keys a="camera" />}>chase camera</HelpLine>
      </aside>
      <aside className={`help help-right ${guideOpen ? "under-guide" : ""}`}>
        <header>
          <b>Radio</b>
          <button type="button" onClick={() => set({ showHelp: false })} aria-label="Hide controls">
            Hide <kbd>{keyName(s.bindings.help[0] ?? "KeyH")}</kbd>
          </button>
        </header>
        <HelpLine k={<Keys a="ptt" extra="or right mouse" />}>hold to talk</HelpLine>
        <HelpLine k={<Keys a={["tuneDown", "tuneUp"]} extra="or wheel" />}>tune 0.1</HelpLine>
        <HelpLine k={<Keys a={["bandDown", "bandUp"]} />}>tune 1.0</HelpLine>
        <HelpLine k={<Keys a="local" />}>local / FM</HelpLine>
        <HelpLine k={<Keys a="guide" />}>station guide</HelpLine>
        <HelpLine
          k={
            <span className="keys">
              <kbd>1</kbd>–<kbd>9</kbd>
            </span>
          }
        >
          presets
        </HelpLine>
        <HelpLine k={<Keys a="settings" />}>settings</HelpLine>
      </aside>
    </>
  );
}

export function Hud({ onSettings }: { onSettings: () => void }) {
  const g = useGame();
  if (g.intro)
    return (
      <div className="hud intro-card">
        <div>
          <b>Port Ardent</b>
          <span>{g.callsign} · coming down</span>
        </div>
        <em>Any key to skip</em>
      </div>
    );
  return <FlyingHud onSettings={onSettings} />;
}

function FlyingHud({ onSettings }: { onSettings: () => void }) {
  const g = useGame();
  const mode = useSettings((s) => s.mode);
  const mouseFlies = useSettings((s) => s.mouseX !== "off" || s.mouseY !== "off");
  const helpKey = useSettings((s) => keyName(s.bindings.help[0] ?? "KeyH"));
  const guideKey = useSettings((s) => keyName(s.bindings.guide[0] ?? "KeyB"));
  const fm = isFm(g.dial);
  const signal = g.radio === "live" ? (fm ? 4 : Math.min(5, 1 + g.inRange)) : g.radio === "off-air" ? 1 : g.radio === "connecting" ? 2 : 0;
  const status = STATUS_TEXT[g.radio] ?? "";
  const crashed = performance.now() - g.crashedAt < 1400;

  let stationLine: ReactNode;
  if (g.radio === "no-signal") stationLine = fm ? "NOTHING ON THIS FREQUENCY" : "OPEN AIR · NOBODY";
  else if (status) stationLine = <span className="blink">{status}…</span>;
  else if (fm) stationLine = g.station?.name ?? "—";
  else stationLine = `OPEN AIR · ${g.inRange} IN RANGE`;

  let hostLine: ReactNode = null;
  if (g.offline) hostLine = "No game server: flying solo, nobody to hear.";
  else if (fm && g.station)
    hostLine = (
      <>
        {g.station.host} · <span className="slogan">{g.station.slogan}</span>
      </>
    );
  else if (!fm) hostLine = "Proximity voice. Pilots near you, where they are.";

  return (
    <div className="hud">
      <div className="osd top-left">
        <div className="callsign">{g.callsign}</div>
        <div className="small">{g.offline ? "SOLO · NO SERVER" : `${g.pilots} PILOT${g.pilots === 1 ? "" : "S"} AIRBORNE`}</div>
        {g.escorts > 0 && <div className="small escorts">{g.escorts} ESCORT{g.escorts === 1 ? "" : "S"} FOLLOWING</div>}
        {g.talkers.length > 0 && (
          <div className="talkers">
            {g.talkers.map((t) => (
              <div key={t.id} className={t.host ? "host" : ""}>
                ◉ {t.host ? (g.station?.host ?? "HOST") : t.callsign}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="osd top-right">
        <div>
          {mode === "angle" ? "ANGLE" : "ACRO"} {g.thirdPerson ? "· CHASE" : ""}
        </div>
        <div className="small">
          {g.landed ? "LANDED" : `${Math.round(g.speed * 3.6)} KM/H`} · ALT {Math.round(g.altitude)} M
        </div>
        <div className="thr" title="throttle">
          THR
          <span className="thr-bar">
            <i style={{ width: `${Math.round(g.throttle * 100)}%` }} />
          </span>
          {Math.round(g.throttle * 100)}%
        </div>
        <div className="hud-buttons">
          <button type="button" className="hud-btn hud-guide" onClick={() => g.set({ guideOpen: !g.guideOpen })}>
            Stations <kbd>{guideKey}</kbd>
          </button>
          <button type="button" className="hud-btn hud-settings" onClick={onSettings}>
            Settings
          </button>
        </div>
      </div>
      <div className="crosshair" />
      {crashed && <div className="signal-lost">SIGNAL LOST</div>}
      {!g.pointerLocked && mouseFlies && !g.settingsOpen && !g.guideOpen && <div className="grab">Click to take the sticks. The mouse flies the drone.</div>}

      <div className="radio">
        <div className="radio-top">
          <div className="lcd">
            <div className="freq">
              {g.dial === LOCAL ? "LOCAL" : dialLabel(g.dial)}
              {fm && <span className="unit">MHz</span>}
            </div>
            <div className="station">{stationLine}</div>
            <div className="host">{hostLine}</div>
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

      {g.showHelp ? (
        <Help />
      ) : (
        <button type="button" className="help-chip" onClick={() => g.set({ showHelp: true })}>
          Controls <kbd>{helpKey}</kbd>
        </button>
      )}
    </div>
  );
}
