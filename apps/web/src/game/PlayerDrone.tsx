import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { BallCollider, RigidBody, useRapier, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import { burst } from "../audio/engine.ts";
import { session } from "../net/session.ts";
import { useGame } from "../state/store.ts";
import { DroneModel } from "./DroneModel.tsx";
import { initialState, rotate, speed, step, type DroneState } from "./flight.ts";
import { readSticks } from "./input.ts";

const RADIUS = 0.3;
const CRASH_SPEED = 9;
const MAP_LIMIT = 1400;
const CEILING = 400;
const UPTILT = { angle: 0.12, acro: 0.42 };
const PROBES: [number, number, number][] = [
  [0, 0, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
];

export function PlayerDrone() {
  const body = useRef<RapierRigidBody>(null);
  const model = useRef<THREE.Group>(null);
  const { world: rw, rapier } = useRapier();
  const camera = useThree((s) => s.camera);
  const drone = useRef<DroneState>(initialState(session.spawn));
  const lastUi = useRef(0);
  const crashUntil = useRef(0);

  const controller = useMemo(() => {
    const c = rw.createCharacterController(0.02);
    c.setSlideEnabled(true);
    c.setApplyImpulsesToDynamicBodies(false);
    return c;
  }, [rw]);
  useEffect(() => () => rw.removeCharacterController(controller), [rw, controller]);

  useEffect(() => {
    const respawn = (spawn: [number, number, number]) => {
      drone.current = initialState(spawn, Math.random() * Math.PI * 2);
      body.current?.setTranslation({ x: spawn[0], y: spawn[1], z: spawn[2] }, true);
    };
    session.respawnListeners.add(respawn);
    return () => void session.respawnListeners.delete(respawn);
  }, []);

  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tilt = useMemo(() => new THREE.Quaternion(), []);

  useFrame((_, rawDt) => {
    const b = body.current;
    const collider = b?.collider(0);
    if (!b || !collider) return;
    const dt = Math.min(rawDt, 1 / 20);
    const g = useGame.getState();
    const now = performance.now();
    const crashed = now < crashUntil.current;

    const sticks = crashed ? { throttle: -0.3, yaw: 0, pitch: 0, roll: 0 } : readSticks(dt);
    const { state, move } = step(drone.current, sticks, dt, g.mode);

    controller.computeColliderMovement(collider, { x: move[0], y: move[1], z: move[2] });
    const m = controller.computedMovement();
    const lost = Math.hypot(move[0] - m.x, move[1] - m.y, move[2] - m.z) / dt;
    let pos: [number, number, number] = [state.pos[0] + m.x, state.pos[1] + m.y, state.pos[2] + m.z];
    let vel = state.vel;
    if (controller.numComputedCollisions() > 0) {
      vel = [m.x / dt, m.y / dt, m.z / dt];
      if (lost > CRASH_SPEED && !crashed) {
        crashUntil.current = now + 1400;
        useGame.getState().set({ crashedAt: now });
        burst(1, 900);
        session.world.crash(lost);
      }
    }
    // soft walls at the edge of the map and a ceiling
    const r = Math.hypot(pos[0], pos[2]);
    if (r > MAP_LIMIT) {
      pos = [(pos[0] / r) * MAP_LIMIT, pos[1], (pos[2] / r) * MAP_LIMIT];
      vel = [vel[0] * 0.5, vel[1], vel[2] * 0.5];
    }
    if (pos[1] > CEILING) {
      pos[1] = CEILING;
      vel = [vel[0], Math.min(0, vel[1]), vel[2]];
    }
    drone.current = { ...state, pos, vel };
    b.setNextKinematicTranslation({ x: pos[0], y: pos[1], z: pos[2] });

    const [qx, qy, qz, qw] = state.quat;
    tmpQ.set(qx, qy, qz, qw);
    model.current?.quaternion.copy(tmpQ);
    model.current?.position.set(pos[0], pos[1], pos[2]);

    // camera: FPV with uptilt, or a chase cam
    if (g.thirdPerson) {
      const fwd = rotate(state.quat, [0, 0, -1]);
      const flat = new THREE.Vector3(fwd[0], 0, fwd[2]).normalize();
      camera.position.set(pos[0] - flat.x * 3.2, pos[1] + 1.1, pos[2] - flat.z * 3.2);
      camera.lookAt(pos[0] + flat.x * 4, pos[1] + 0.2, pos[2] + flat.z * 4);
    } else {
      camera.position.set(pos[0], pos[1] + 0.05, pos[2]);
      tilt.setFromAxisAngle(new THREE.Vector3(1, 0, 0), UPTILT[g.mode]);
      camera.quaternion.copy(tmpQ).multiply(tilt);
    }
    if (model.current) model.current.visible = g.thirdPerson;

    // analog video breakup: close to walls, beyond the map edge, right after a crash
    let nearest = 8;
    for (const dir of PROBES) {
      const d = rotate(state.quat, dir);
      const hit = rw.castRay(new rapier.Ray({ x: pos[0], y: pos[1], z: pos[2] }, { x: d[0], y: d[1], z: d[2] }), 8, true, undefined, undefined, collider);
      if (hit && hit.timeOfImpact < nearest) nearest = hit.timeOfImpact;
    }
    const wall = Math.max(0, 1 - nearest / 6) ** 2;
    const edge = Math.max(0, (r - MAP_LIMIT * 0.8) / (MAP_LIMIT * 0.2));
    const crashFx = crashed ? (crashUntil.current - now) / 1400 : 0;
    const breakup = Math.min(1, Math.max(wall * 0.8, edge, crashFx));

    // network + audio listener
    session.world.sendPose(pos, state.quat, now);
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const inRange = session.voice?.updateSpatial(
      { pos: [camera.position.x, camera.position.y, camera.position.z], fwd: [camFwd.x, camFwd.y, camFwd.z], up: [camUp.x, camUp.y, camUp.z] },
      session.positions,
    );

    if (now - lastUi.current > 100) {
      lastUi.current = now;
      g.set({ speed: speed(vel), altitude: pos[1], breakup, inRange: inRange ?? 0, pilots: session.world.pilots.size + 1 });
    } else if (Math.abs(breakup - g.breakup) > 0.05) {
      g.set({ breakup });
    }
  });

  return (
    <>
      <RigidBody ref={body} type="kinematicPosition" colliders={false} position={session.spawn} ccd>
        <BallCollider args={[RADIUS]} />
      </RigidBody>
      <group ref={model}>
        <DroneModel led="#3fa7ff" tx={useGame((s) => s.ptt === "on")} />
      </group>
    </>
  );
}
