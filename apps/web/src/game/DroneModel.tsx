import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Mesh } from "three";

const ARM = 0.21;
const PROPS: [number, number][] = [
  [ARM, ARM],
  [-ARM, ARM],
  [ARM, -ARM],
  [-ARM, -ARM],
];

/** A small 5-inch quad: carbon frame, four spinning props, a status LED. */
export function DroneModel({ led = "#ff3b2f", tx = false }: { led?: string; tx?: boolean }) {
  const props = useRef<(Mesh | null)[]>([]);
  const ledRef = useRef<Mesh>(null);
  useFrame((_, dt) => {
    props.current.forEach((p, i) => p && (p.rotation.y += (i % 2 ? -1 : 1) * dt * 60));
    if (ledRef.current) ledRef.current.visible = !tx || Math.floor(performance.now() / 120) % 2 === 0;
  });
  return (
    <group>
      <mesh castShadow>
        <boxGeometry args={[0.12, 0.05, 0.22]} />
        <meshStandardMaterial color="#1b1d1f" roughness={0.6} metalness={0.3} />
      </mesh>
      <mesh rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[0.62, 0.015, 0.035]} />
        <meshStandardMaterial color="#2a2d30" roughness={0.8} />
      </mesh>
      <mesh rotation={[0, -Math.PI / 4, 0]}>
        <boxGeometry args={[0.62, 0.015, 0.035]} />
        <meshStandardMaterial color="#2a2d30" roughness={0.8} />
      </mesh>
      {PROPS.map(([x, z], i) => (
        <group key={i} position={[x, 0.035, z]}>
          <mesh>
            <cylinderGeometry args={[0.025, 0.025, 0.04, 8]} />
            <meshStandardMaterial color="#555" metalness={0.6} roughness={0.4} />
          </mesh>
          <mesh ref={(m) => (props.current[i] = m)} position={[0, 0.025, 0]}>
            <boxGeometry args={[0.26, 0.004, 0.025]} />
            <meshStandardMaterial color="#c9c2b0" transparent opacity={0.55} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.03, -0.12]}>
        <boxGeometry args={[0.05, 0.04, 0.03]} />
        <meshStandardMaterial color="#111" />
      </mesh>
      <mesh ref={ledRef} position={[0, 0.0, 0.12]}>
        <sphereGeometry args={[0.025, 8, 8]} />
        <meshBasicMaterial color={tx ? "#7dff6a" : led} toneMapped={false} />
      </mesh>
    </group>
  );
}
