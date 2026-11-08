import { Suspense, useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import type * as THREE from "three";
import { useGame } from "../state/store.ts";
import { City } from "./City.tsx";
import type { CityMeta } from "./useCityMeta.ts";
import { Effects } from "./Effects.tsx";
import { installInput } from "./input.ts";
import { PlayerDrone } from "./PlayerDrone.tsx";
import { RemoteDrones } from "./RemoteDrones.tsx";

const SKY = "#8a8e91";

function Inputs() {
  const gl = useThree((s) => s.gl);
  useEffect(() => installInput(gl.domElement), [gl]);
  return null;
}

function Atmosphere() {
  return (
    <>
      <color attach="background" args={[SKY]} />
      <fog attach="fog" args={[SKY, 60, 1100]} />
      <hemisphereLight args={["#b9c0c4", "#3b342b", 1.1]} />
      <directionalLight position={[-300, 220, 160]} intensity={1.6} color="#ffd2a1" />
      <ambientLight intensity={0.15} />
    </>
  );
}

export function Scene({ meta }: { meta: CityMeta | null }) {
  const fov = useGame((s) => (s.thirdPerson ? 75 : 100));
  return (
    <Canvas
      className="scene"
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      camera={{ fov, near: 0.05, far: 2500 }}
      onCreated={({ camera }) => {
        (camera as THREE.PerspectiveCamera).fov = fov;
      }}
    >
      <FovSync fov={fov} />
      <Inputs />
      <Atmosphere />
      <Suspense fallback={null}>
        <Physics gravity={[0, 0, 0]} timeStep="vary">
          <City meta={meta} />
          <PlayerDrone />
        </Physics>
        <RemoteDrones />
      </Suspense>
      <Effects />
    </Canvas>
  );
}


function FovSync({ fov }: { fov: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  useEffect(() => {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }, [camera, fov]);
  return null;
}
