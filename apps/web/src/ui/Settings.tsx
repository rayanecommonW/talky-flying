import { useEffect, useState, type ReactNode } from "react";
import { captureNextKey } from "../game/input.ts";
import {
  ACTION_LABEL,
  keyName,
  useSettings,
  type BindAction,
  type Layout,
  type Settings as S,
} from "../state/settings.ts";
import { useGame } from "../state/store.ts";

type Tab = "controls" | "flight" | "audio" | "voices";
const TABS: [Tab, string][] = [
  ["controls", "Controls"],
  ["flight", "Flight"],
  ["audio", "Sound"],
  ["voices", "Station voices"],
];

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="choice" role="radiogroup">
      {options.map(([v, label]) => (
        <button type="button" role="radio" aria-checked={v === value} key={String(v)} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="srow">
      <div className="srow-label">
        {label}
        {hint && <small>{hint}</small>}
      </div>
      <div className="srow-control">{children}</div>
    </div>
  );
}

function Slider({ value, min, max, step = 1, unit = "", format, onChange }: { value: number; min: number; max: number; step?: number; unit?: string; format?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{format ? format(value) : `${value}${unit}`}</output>
    </div>
  );
}

/** 0..1 volume with an off switch that remembers the previous level. */
function Volume({ k, label, hint }: { k: "volMaster" | "volVoice" | "volStatic" | "volTones"; label: string; hint?: string }) {
  const v = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  const [last, setLast] = useState(v || 0.5);
  return (
    <Row label={label} hint={hint}>
      <div className="slider">
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(v * 100)}
          onChange={(e) => {
            const n = Number(e.target.value) / 100;
            if (n > 0) setLast(n);
            set({ [k]: n } as Partial<S>);
          }}
        />
        <output>{v === 0 ? "Off" : `${Math.round(v * 100)}%`}</output>
        <button type="button" className="mini" onClick={() => set({ [k]: v === 0 ? last : 0 } as Partial<S>)}>
          {v === 0 ? "Turn on" : "Mute"}
        </button>
      </div>
    </Row>
  );
}

function KeySlot({ action, slot }: { action: BindAction; slot: number }) {
  const code = useSettings((s) => s.bindings[action][slot]);
  const bind = useSettings((s) => s.bind);
  const [listening, setListening] = useState(false);
  useEffect(() => () => captureNextKey(null), []);
  return (
    <button
      type="button"
      className={`keycap ${listening ? "listening" : ""} ${code ? "" : "empty"}`}
      onClick={() => {
        if (listening) {
          captureNextKey(null);
          setListening(false);
          return;
        }
        setListening(true);
        captureNextKey((c) => {
          setListening(false);
          if (c === "Escape") return; // cancel
          bind(action, c === "Backspace" || c === "Delete" ? "" : c, slot);
        });
      }}
      title={listening ? "Press a key. Backspace clears, Esc cancels." : "Click to change"}
    >
      {listening ? "Press a key" : code ? keyName(code) : "—"}
    </button>
  );
}

const GROUPS: [string, BindAction[]][] = [
  ["Flying", ["throttleUp", "throttleDown", "yawLeft", "yawRight", "pitchForward", "pitchBack", "rollLeft", "rollRight", "mode", "reset", "camera"]],
  ["Radio", ["ptt", "tuneUp", "tuneDown", "bandUp", "bandDown", "local", "guide"]],
  ["Menus", ["help", "settings"]],
];

function ControlsTab() {
  const s = useSettings();
  return (
    <>
      <Row
        label="Layout"
        hint={
          s.layout === "arcade"
            ? "The drone levels itself. W/S lean forward and back, A/D lean and slide sideways, Space/Shift up and down, the mouse turns."
            : s.layout === "fpv"
              ? "Acro, nothing levels itself: W/S throttle, A/D roll, Q/E yaw, the mouse steers. Flips, dives, real FPV."
              : "Your own bindings. Pick a layout to start over from it."
        }
      >
        <Choice<Layout | "custom">
          value={s.layout}
          options={[
            ["arcade", "Simple"],
            ["fpv", "FPV acro"],
            ...(s.layout === "custom" ? ([["custom", "Custom"]] as [Layout | "custom", string][]) : []),
          ]}
          onChange={(v) => v !== "custom" && s.applyLayout(v)}
        />
      </Row>
      <Row label="Mouse left/right">
        <Choice value={s.mouseX} options={[["roll", "Roll"], ["yaw", "Yaw"], ["off", "Nothing"]]} onChange={(mouseX) => s.set({ mouseX, layout: "custom" })} />
      </Row>
      <Row label="Mouse up/down" hint="Mouse down tips the nose down, like looking down.">
        <Choice value={s.mouseY} options={[["pitch", "Pitch"], ["off", "Nothing"]]} onChange={(mouseY) => s.set({ mouseY, layout: "custom" })} />
        <label className="check">
          <input type="checkbox" checked={s.invertMouseY} onChange={(e) => s.set({ invertMouseY: e.target.checked })} /> Invert
        </label>
      </Row>
      <Row label="Mouse sensitivity" hint="Degrees the drone turns per pixel.">
        <Slider value={s.mouseSens} min={0.02} max={0.4} step={0.01} format={(v) => `${v.toFixed(2)}°`} onChange={(mouseSens) => s.set({ mouseSens })} />
      </Row>
      <Row
        label="Throttle keys"
        hint={s.throttleKeys === "spring" ? "Let go and the throttle drifts back to hover." : "The throttle stays where you leave it, like a real throttle stick."}
      >
        <Choice value={s.throttleKeys} options={[["spring", "Spring to hover"], ["ramp", "Stay put"]]} onChange={(throttleKeys) => s.set({ throttleKeys })} />
      </Row>

      <div className="bindings">
        {GROUPS.map(([title, actions]) => (
          <section key={title}>
            <h3>{title}</h3>
            {actions.map((a) => (
              <div className="bind" key={a}>
                <span>{ACTION_LABEL[a]}</span>
                <KeySlot action={a} slot={0} />
                <KeySlot action={a} slot={1} />
              </div>
            ))}
          </section>
        ))}
        <section>
          <h3>Fixed</h3>
          <div className="bind fixed">
            <span>Talk</span>
            <i>Right mouse</i>
          </div>
          <div className="bind fixed">
            <span>Tune</span>
            <i>Mouse wheel</i>
          </div>
          <div className="bind fixed">
            <span>Station presets</span>
            <i>1 to 9</i>
          </div>
        </section>
      </div>

      <Row label="Gamepad or RC radio" hint="Mode 2: throttle and yaw on the left stick. Mode 1: throttle on the right.">
        <Choice value={s.padMode} options={[[2, "Mode 2"], [1, "Mode 1"]]} onChange={(padMode) => s.set({ padMode })} />
        <Choice value={s.padThrottle} options={[["centered", "Gamepad stick"], ["radio", "RC throttle"]]} onChange={(padThrottle) => s.set({ padThrottle })} />
      </Row>
    </>
  );
}

function FlightTab() {
  const s = useSettings();
  const rate = (k: "rates" | "yawRates", f: "center" | "max" | "expo", v: number) => s.set({ [k]: { ...s[k], [f]: v } } as Partial<S>);
  return (
    <>
      <Row
        label="Flight mode"
        hint={
          s.mode === "acro"
            ? "Acro: sticks spin the drone, nothing levels it for you. Flips, rolls, dives. How FPV pilots fly."
            : "Angle: the drone levels itself, leaning moves it, the throttle keys only climb and sink. Easier, but no flips."
        }
      >
        <Choice value={s.mode} options={[["acro", "Acro"], ["angle", "Angle (self-level)"]]} onChange={(mode) => s.set({ mode })} />
      </Row>
      <Row label="Gravity" hint="Heavier drops faster and carries more momentum.">
        <Slider value={s.gravity} min={9.81 * 0.5} max={9.81 * 3} step={9.81 * 0.1} format={(v) => `${(v / 9.81).toFixed(1)} g`} onChange={(gravity) => s.set({ gravity })} />
      </Row>
      <Row label="Power" hint="Thrust-to-weight. Hover throttle is 1 ÷ this in acro.">
        <Slider value={s.twr} min={2} max={10} step={0.5} format={(v) => `${v.toFixed(1)} : 1`} onChange={(twr) => s.set({ twr })} />
      </Row>
      <h3 className="sub">Roll and pitch rates</h3>
      <Row label="Centre sensitivity">
        <Slider value={s.rates.center} min={50} max={500} step={10} unit="°/s" onChange={(v) => rate("rates", "center", v)} />
      </Row>
      <Row label="Max rate" hint="Full stick or held key.">
        <Slider value={s.rates.max} min={200} max={1800} step={10} unit="°/s" onChange={(v) => rate("rates", "max", v)} />
      </Row>
      <Row label="Expo">
        <Slider value={s.rates.expo} min={0} max={0.95} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => rate("rates", "expo", v)} />
      </Row>
      <h3 className="sub">Yaw rates</h3>
      <Row label="Centre sensitivity">
        <Slider value={s.yawRates.center} min={50} max={500} step={10} unit="°/s" onChange={(v) => rate("yawRates", "center", v)} />
      </Row>
      <Row label="Max rate">
        <Slider value={s.yawRates.max} min={100} max={1200} step={10} unit="°/s" onChange={(v) => rate("yawRates", "max", v)} />
      </Row>
      <h3 className="sub">Camera</h3>
      <Row label="Camera uptilt" hint="Acro only. More tilt suits faster forward flight.">
        <Slider value={s.cameraTilt} min={0} max={50} unit="°" onChange={(cameraTilt) => s.set({ cameraTilt })} />
      </Row>
      <Row label="Field of view" hint="Horizontal. Wider feels smaller and faster.">
        <Slider value={s.fov} min={70} max={160} unit="°" onChange={(fov) => s.set({ fov })} />
      </Row>
      <Row label="Angle mode max tilt">
        <Slider value={s.angleMaxTilt} min={20} max={80} unit="°" onChange={(angleMaxTilt) => s.set({ angleMaxTilt })} />
      </Row>
    </>
  );
}

function AudioTab() {
  return (
    <>
      <Volume k="volMaster" label="Master" />
      <Volume k="volVoice" label="Voices" hint="Pilots and station hosts." />
      <Volume k="volStatic" label="Static and noise" hint="Hiss while tuning, between stations and after a crash." />
      <Volume k="volTones" label="Beeps" hint="Key-up chirps, busy tones, dial clicks." />
    </>
  );
}

function VoicesTab() {
  const speech = useSettings((s) => s.speech);
  const set = useSettings((s) => s.set);
  const hostSpeech = useGame((s) => s.hostSpeech);
  const radio = useGame((s) => s.radio);
  return (
    <>
      <Row
        label="Speech engine"
        hint={
          speech === "local"
            ? "Kokoro speaks and Whisper listens, both running on the game server. Free, a little robotic."
            : "ElevenLabs voices and transcription. Much more natural; uses the server's ElevenLabs credit."
        }
      >
        <Choice value={speech} options={[["local", "Kokoro + Whisper"], ["elevenlabs", "ElevenLabs"]]} onChange={(v) => set({ speech: v })} />
      </Row>
      <p className="note">
        The host of the station you're tuned to switches at the next sentence. Everyone on that frequency hears the same voice, so the last
        listener to choose wins. If ElevenLabs is unavailable the host stays on Kokoro.
      </p>
      {radio === "live" && hostSpeech && (
        <p className="note now">Station you're on is using {hostSpeech === "elevenlabs" ? "ElevenLabs" : "Kokoro + Whisper"} right now.</p>
      )}
    </>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("controls");
  const reset = useSettings((s) => s.reset);
  return (
    <div className="settings-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-label="Settings">
        <nav>
          <h2>Settings</h2>
          {TABS.map(([t, label]) => (
            <button type="button" key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
          <div className="nav-foot">
            <button type="button" className="mini" onClick={() => confirm("Reset every setting to its default?") && reset()}>
              Reset all
            </button>
            <button type="button" className="close" onClick={onClose}>
              Done
            </button>
          </div>
        </nav>
        <div className="settings-body">
          {tab === "controls" && <ControlsTab />}
          {tab === "flight" && <FlightTab />}
          {tab === "audio" && <AudioTab />}
          {tab === "voices" && <VoicesTab />}
        </div>
      </div>
    </div>
  );
}
