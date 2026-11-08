import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import * as THREE from "three";
import { dialLabel } from "@dead-air/shared";
import { INTERP_DELAY_MS } from "../net/interp.ts";
import { session } from "../net/session.ts";
import type { RemotePilot } from "../net/world.ts";
import { DroneModel } from "./DroneModel.tsx";

function RemoteDrone({ pilot }: { pilot: RemotePilot }) {
  const group = useRef<THREE.Group>(null);
  const label = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera);
  const [tx, setTx] = useState(false);
  const [dial, setDial] = useState(pilot.dial);

  useFrame(() => {
    const s = pilot.buf.sample(performance.now() - INTERP_DELAY_MS);
    if (!s || !group.current) return;
    group.current.position.set(...s.p);
    group.current.quaternion.set(...s.q);
    session.positions.set(pilot.id, s.p);
    if (label.current) {
      const d = camera.position.distanceTo(group.current.position);
      const k = Math.max(1, d / 25);
      label.current.scale.setScalar(k);
      label.current.position.set(s.p[0], s.p[1] + 0.45 + 0.25 * k, s.p[2]);
    }
    if (pilot.tx !== tx) setTx(pilot.tx);
    if (pilot.dial !== dial) setDial(pilot.dial);
  });
  useEffect(() => () => void session.positions.delete(pilot.id), [pilot.id]);

  return (
    <>
      <group ref={group}>
        <DroneModel tx={tx} />
      </group>
      <group ref={label}>
        <Billboard>
          <Text fontSize={0.32} color={tx ? "#9dff8a" : "#ffcf70"} outlineWidth={0.03} outlineColor="#000" anchorY="bottom">
            {pilot.callsign}
          </Text>
          <Text fontSize={0.2} color="#c8c0b0" outlineWidth={0.02} outlineColor="#000" anchorY="top" position={[0, -0.04, 0]}>
            {tx ? "TX " : ""}
            {dialLabel(dial)}
          </Text>
        </Billboard>
      </group>
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
