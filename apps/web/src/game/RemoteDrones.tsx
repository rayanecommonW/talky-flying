import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { INTERP_DELAY_MS } from "../net/interp.ts";
import { session } from "../net/session.ts";
import type { RemotePilot } from "../net/world.ts";
import { DroneModel } from "./DroneModel.tsx";

/** Same size as our own drone. */
const MODEL_SCALE = 0.45;
/** No name tags: other drones glow, more the further away they are, so you can find them across town. */
const GLOW_NEAR = 6;
const GLOW_FAR = 40;

let glowTexture: THREE.Texture | null = null;
function glowMap(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.18, "rgba(255,255,255,0.75)");
  r.addColorStop(0.5, "rgba(255,255,255,0.18)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

const PILOT = new THREE.Color("#ffb347");
const TALKING = new THREE.Color("#8dff7a");
const ESCORT = new THREE.Color("#6fc3ff");

function RemoteDrone({ pilot }: { pilot: RemotePilot }) {
  const group = useRef<THREE.Group>(null);
  const glow = useRef<THREE.Sprite>(null);
  const camera = useThree((s) => s.camera);
  const [tx, setTx] = useState(false);
  const mat = useMemo(
    () => new THREE.SpriteMaterial({ map: glowMap(), color: PILOT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    [],
  );
  useEffect(() => () => mat.dispose(), [mat]);

  useFrame(() => {
    const s = pilot.buf.sample(performance.now() - INTERP_DELAY_MS);
    if (!s || !group.current) return;
    group.current.position.set(...s.p);
    group.current.quaternion.set(...s.q);
    if (!pilot.owner) session.positions.set(pilot.id, s.p);
    if (glow.current) {
      const d = camera.position.distanceTo(group.current.position);
      const far = Math.min(1, Math.max(0, (d - GLOW_NEAR) / (GLOW_FAR - GLOW_NEAR)));
      glow.current.position.set(...s.p);
      // Roughly constant size on screen once far away, so a pilot across town is still a visible spark.
      glow.current.scale.setScalar(0.35 + d * 0.028);
      const pulse = pilot.tx ? 0.75 + 0.25 * Math.sin(performance.now() / 90) : 1;
      mat.opacity = (0.15 + 0.85 * far) * pulse * (pilot.owner ? 0.6 : 1);
      mat.color.copy(pilot.owner ? ESCORT : pilot.tx ? TALKING : PILOT);
    }
    if (pilot.tx !== tx) setTx(pilot.tx);
  });
  useEffect(() => () => void session.positions.delete(pilot.id), [pilot.id]);

  return (
    <>
      <group ref={group}>
        <group scale={MODEL_SCALE}>
          <DroneModel tx={tx} led={pilot.owner ? "#6fc3ff" : undefined} />
        </group>
      </group>
      <sprite ref={glow} material={mat} renderOrder={10} />
    </>
  );
}

export function RemoteDrones() {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const t = setInterval(() => {
      const next = [...session.world.pilots.keys()].sort();
      setIds((prev) => (prev.join() === next.join() ? prev : next));
    }, 250);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      {ids.map((id) => {
        const p = session.world.pilots.get(id);
        return p ? <RemoteDrone key={id} pilot={p} /> : null;
      })}
    </>
  );
}
