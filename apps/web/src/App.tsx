import { lazy, Suspense, useEffect } from "react";
import { session } from "./net/session.ts";
import { onAction } from "./game/input.ts";
import { useCityMeta } from "./game/useCityMeta.ts";

// three.js + Rapier (wasm) are big: load them after the start screen is up.
const Scene = lazy(() => import("./game/Scene.tsx").then((m) => ({ default: m.Scene })));
import { useGame } from "./state/store.ts";
import { Hud } from "./ui/Hud.tsx";
import { StartScreen } from "./ui/StartScreen.tsx";

function useRadioControls(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    return onAction((action, down) => {
      const r = session.radio;
      const g = useGame.getState();
      if (action === "ptt") return down ? r.pressPtt() : r.releasePtt();
      if (!down) return;
      if (action === "tune+") r.step(1);
      else if (action === "tune-") r.step(-1);
      else if (action === "band+") r.step(10);
      else if (action === "band-") r.step(-10);
      else if (action === "local") r.toggleLocal();
      else if (action === "mode") g.set({ mode: g.mode === "angle" ? "acro" : "angle" });
      else if (action === "camera") g.set({ thirdPerson: !g.thirdPerson });
      else if (action === "help") g.set({ showHelp: !g.showHelp });
      else if (action.startsWith("preset")) r.preset(Number(action.slice(6)));
    });
  }, [enabled]);
}

export function App() {
  const phase = useGame((s) => s.phase);
  const meta = useCityMeta();
  const flying = phase === "flying";
  useRadioControls(flying);
  return (
    <>
      {flying && meta !== undefined && (
        <Suspense fallback={null}>
          <Scene meta={meta} />
        </Suspense>
      )}
      {flying ? <Hud /> : <StartScreen />}
    </>
  );
}
