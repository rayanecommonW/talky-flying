import { lazy, Suspense, useEffect } from "react";
import { session } from "./net/session.ts";
import { onAction, unlockPointer } from "./game/input.ts";
import { useCityMeta } from "./game/useCityMeta.ts";
import { settings } from "./state/settings.ts";
import { useGame } from "./state/store.ts";
import { Hud } from "./ui/Hud.tsx";
import { StationGuide } from "./ui/Guide.tsx";
import { SettingsPanel } from "./ui/Settings.tsx";
import { StartScreen } from "./ui/StartScreen.tsx";

// three.js + Rapier (wasm) are big: load them after the start screen is up.
const Scene = lazy(() => import("./game/Scene.tsx").then((m) => ({ default: m.Scene })));

function setSettingsOpen(open: boolean) {
  if (open) unlockPointer();
  useGame.getState().set({ settingsOpen: open });
}

function useControls(flying: boolean) {
  useEffect(
    () =>
      onAction((action, down) => {
        if (action === "settings" && down) return setSettingsOpen(!useGame.getState().settingsOpen);
        if (!flying) return;
        const r = session.radio;
        const g = useGame.getState();
        if (action === "ptt") return down ? r.pressPtt() : r.releasePtt();
        if (!down) return;
        if (action === "tuneUp") r.step(1);
        else if (action === "tuneDown") r.step(-1);
        else if (action === "bandUp") r.step(10);
        else if (action === "bandDown") r.step(-10);
        else if (action === "local") r.toggleLocal();
        else if (action === "mode") settings().set({ mode: settings().mode === "angle" ? "acro" : "angle" });
        else if (action === "camera") g.set({ thirdPerson: !g.thirdPerson });
        else if (action === "help") g.set({ showHelp: !g.showHelp });
        else if (action === "guide") {
          // The guide is clicked, so it needs the mouse back.
          if (!g.guideOpen) unlockPointer();
          g.set({ guideOpen: !g.guideOpen });
        }
        else if (action.startsWith("preset")) r.preset(Number(action.slice(6)));
      }),
    [flying],
  );
}

export function App() {
  const phase = useGame((s) => s.phase);
  const settingsOpen = useGame((s) => s.settingsOpen);
  const guideOpen = useGame((s) => s.guideOpen && !s.intro);
  const meta = useCityMeta();
  const flying = phase === "flying";
  useControls(flying);
  const open = () => setSettingsOpen(true);
  return (
    <>
      {flying && meta !== undefined && (
        <Suspense fallback={null}>
          <Scene meta={meta} />
        </Suspense>
      )}
      {flying ? <Hud onSettings={open} /> : <StartScreen onSettings={open} />}
      {flying && guideOpen && <StationGuide />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
