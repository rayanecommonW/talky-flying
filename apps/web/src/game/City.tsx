import { Suspense, useMemo } from "react";
import type { CityMeta } from "./useCityMeta.ts";
import { useGLTF } from "@react-three/drei";
import { CuboidCollider, RigidBody } from "@react-three/rapier";
import * as THREE from "three";

function BlenderCity() {
  const visual = useGLTF("/city/city.glb", false, true);
  const collision = useGLTF("/city/collision.glb", false, false);
  const colliderScene = useMemo(() => {
    const s = collision.scene.clone(true);
    s.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = new THREE.MeshBasicMaterial({ visible: false });
    });
    return s;
  }, [collision.scene]);
  useMemo(() => {
    visual.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = true;
        m.frustumCulled = true;
      }
    });
  }, [visual.scene]);
  return (
    <>
      <primitive object={visual.scene} />
      <RigidBody type="fixed" colliders="trimesh" includeInvisible>
        <primitive object={colliderScene} />
      </RigidBody>
    </>
  );
}

/** Seeded procedural ruins: used until tools/city has produced city.glb. */
function Blockout() {
  const boxes = useMemo(() => {
    let a = 1337;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out: { p: [number, number, number]; s: [number, number, number]; c: string }[] = [];
    const palette = ["#5b534b", "#6b5d50", "#4c4a47", "#7a6a58", "#3f3c39"];
    for (let gx = -8; gx <= 8; gx++) {
      for (let gz = -8; gz <= 8; gz++) {
        if (Math.abs(gx) % 4 === 0 || Math.abs(gz) % 3 === 0) continue; // streets
        if (rand() < 0.18) continue; // rubble lots
        const w = 14 + rand() * 12;
        const d = 14 + rand() * 12;
        const ruined = rand() < 0.35;
        const h = ruined ? 3 + rand() * 8 : 10 + rand() * (Math.hypot(gx, gz) < 4 ? 45 : 25);
        out.push({ p: [gx * 32 + (rand() - 0.5) * 6, h / 2, gz * 32 + (rand() - 0.5) * 6], s: [w, h, d], c: palette[Math.floor(rand() * palette.length)] });
      }
    }
    out.push({ p: [0, 45, 0], s: [10, 90, 10], c: "#6d6256" }); // the belfry
    return out;
  }, []);
  return (
    <>
      {boxes.map((b, i) => (
        <RigidBody key={i} type="fixed" colliders={false} position={b.p}>
          <CuboidCollider args={[b.s[0] / 2, b.s[1] / 2, b.s[2] / 2]} />
          <mesh receiveShadow>
            <boxGeometry args={b.s} />
            <meshStandardMaterial color={b.c} roughness={0.95} />
          </mesh>
        </RigidBody>
      ))}
    </>
  );
}

/** Visual ground for the blockout; with the Blender city (which has its own terrain and recessed water) only a safety floor. */
function Ground({ floor, visible }: { floor: number; visible: boolean }) {
  return (
    <RigidBody type="fixed" colliders={false}>
      <CuboidCollider args={[2000, 1, 2000]} position={[0, floor - 1, 0]} />
      {visible && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.02, 0]}>
          <planeGeometry args={[4000, 4000]} />
          <meshStandardMaterial color="#3d3a33" roughness={1} />
        </mesh>
      )}
    </RigidBody>
  );
}

export function City({ meta }: { meta: CityMeta | null }) {
  return (
    <>
      <Ground floor={meta ? meta.bounds.min[1] - 2 : 0} visible={!meta} />
      {meta ? (
        <Suspense fallback={null}>
          <BlenderCity />
        </Suspense>
      ) : (
        <Blockout />
      )}
    </>
  );
}
