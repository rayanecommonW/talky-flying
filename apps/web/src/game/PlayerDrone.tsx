import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import * as THREE from "three";
import { burst, whoosh } from "../audio/engine.ts";
import { session } from "../net/session.ts";
import { useGame } from "../state/store.ts";
import { DroneModel } from "./DroneModel.tsx";
import { aimDir, fromYawPitchRoll, hoverThrottle, initialState, rotate, settle, speed, step, takeoffThrottle, upright, type DroneState, type Vec3 } from "./flight.ts";
import { onAction, readMouse, readSticks, resetSticks } from "./input.ts";
import { settings, useSettings } from "../state/settings.ts";

type Collider = ReturnType<ReturnType<typeof useRapier>["world"]["createCollider"]>;

/** Collision sphere: a palm-sized whoop, small enough to thread between railings and chimneys. */
const RADIUS = 0.12;
/** The model is drawn at this scale (DroneModel is a 5" quad). */
const MODEL_SCALE = 0.45;
/** Simple mode: stick past this lifts off a landed drone, under it it can land. */
const MOVE_STICK = 0.2;
const CRASH_SPEED = 12;
/** A landing needs the drone upright, sinking, and nearly stopped sideways. */
const LAND_MAX_SIDEWAYS = 9;
const MAP_LIMIT = 1400;
const CEILING = 400;
const FOG: [number, number] = [60, 1100];
const PROBES: Vec3[] = [
  [0, 0, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
];

// ---------- the fly-in after power-on: the whole city from the sky, three drops, then into the drone ----------

const H0 = 1250;
const H1 = 420;
const H2 = 120;
/** [start s, end s, kind, height from, height to] */
const SHOTS: [number, number, "hold" | "drop", number, number][] = [
  [0, 0.8, "hold", H0, H0 * 0.97],
  [0.8, 1.25, "drop", H0 * 0.97, H1],
  [1.25, 1.65, "hold", H1, H1 * 0.95],
  [1.65, 2.1, "drop", H1 * 0.95, H2],
  [2.1, 2.45, "hold", H2, H2 * 0.95],
];
const SWOOP_START = 2.45;
const INTRO_END = 3.35;
const WHOOSHES = [0.8, 1.65, SWOOP_START];
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

export function PlayerDrone({ floor }: { floor: number }) {
  const model = useRef<THREE.Group>(null);
  const { world: rw, rapier } = useRapier();
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const drone = useRef<DroneState>(initialState(session.spawn));
  const collider = useRef<Collider | null>(null);
  const lastUi = useRef(0);
  const crashUntil = useRef(0);
  const landed = useRef(false);
  const hop = useRef(0);
  /** Wall-clock start of the fly-in (ms), so a slow first few frames don't stretch it. */
  const intro = useRef({ start: -1, whooshed: 0 });

  const controller = useMemo(() => {
    const c = rw.createCharacterController(0.02);
    c.setSlideEnabled(true);
    c.setApplyImpulsesToDynamicBodies(false);
    return c;
  }, [rw]);
  useEffect(() => () => rw.removeCharacterController(controller), [rw, controller]);

  // A free collider (no rigid body) that we move ourselves every frame, so collision queries always
  // start from exactly where the drone is, whatever the physics step did or didn't do.
  useEffect(() => {
    const [x, y, z] = drone.current.pos;
    const c = rw.createCollider(rapier.ColliderDesc.ball(RADIUS).setTranslation(x, y, z));
    collider.current = c;
    return () => {
      collider.current = null;
      rw.removeCollider(c, false);
    };
  }, [rw, rapier]);

  useEffect(() => {
    useGame.getState().set({ intro: true, landed: false });
    const skip = () => {
      const i = intro.current;
      const now = performance.now();
      if (i.start >= 0 && now - i.start < SWOOP_START * 1000) {
        i.start = now - SWOOP_START * 1000;
        i.whooshed = WHOOSHES.length - 1;
      }
    };
    window.addEventListener("keydown", skip);
    window.addEventListener("mousedown", skip);
    if (import.meta.env.DEV) {
      // test hooks for e2e
      const dbg = session as unknown as Record<string, unknown>;
      dbg.droneUp = () => rotate(drone.current.quat, [0, 1, 0])[1];
      dbg.droneFwd = () => rotate(drone.current.quat, [0, 0, -1])[1];
      dbg.dronePos = () => drone.current.pos;
      dbg.droneTeleport = (p: Vec3, v: Vec3 = [0, 0, 0]) => {
        drone.current = { ...drone.current, pos: [...p], vel: [...v] };
        landed.current = false;
      };
    }
    const respawn = (spawn: Vec3) => {
      drone.current = initialState(spawn, Math.random() * Math.PI * 2);
      landed.current = false;
      resetSticks();
    };
    session.respawnListeners.add(respawn);
    const off = onAction((a, down) => {
      if (!down) return;
      if (a === "reset") {
        // Flip upright and hop up a little: the turtle-mode escape when you land upside down.
        drone.current = upright(drone.current);
        hop.current = 1.5;
        landed.current = false;
        resetSticks();
      }
    });
    const offMode = useSettings.subscribe((s, prev) => {
      if (s.mode !== prev.mode) resetSticks();
    });
    return () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("mousedown", skip);
      session.respawnListeners.delete(respawn);
      off();
      offMode();
      useGame.getState().set({ intro: false });
    };
  }, []);

  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const camQ = useMemo(() => new THREE.Quaternion(), []);
  const lookDown = useMemo(() => new THREE.Quaternion(), []);
  const uptilt = useMemo(() => new THREE.Quaternion(), []);
  const X = useMemo(() => new THREE.Vector3(1, 0, 0), []);

  /** Where the camera sits for the current drone state (FPV or chase). */
  function placeCamera(s: DroneState, pos: Vec3, thirdPerson: boolean) {
    const cfg = settings();
    if (thirdPerson) {
      // Tight chase cam, just behind the little drone, along where it's looking.
      const [ax, ay, az] = aimDir({ yawAngle: s.yawAngle, look: cfg.mode === "angle" ? s.look : 0 });
      camera.position.set(pos[0] - ax * 0.55, pos[1] - ay * 0.55 + 0.14, pos[2] - az * 0.55);
      camera.lookAt(pos[0] + ax * 3, pos[1] + ay * 3 + 0.05, pos[2] + az * 3);
      return;
    }
    camera.position.set(pos[0], pos[1] + 0.015, pos[2]);
    if (cfg.mode === "acro") {
      // FPV cameras are tilted up so the horizon sits level when the quad leans into forward flight.
      const [qx, qy, qz, qw] = s.quat;
      camQ.set(qx, qy, qz, qw);
      uptilt.setFromAxisAngle(X, (cfg.cameraTilt * Math.PI) / 180);
    } else {
      // Mouse-aim: the camera looks where the mouse says, with only a hint of the body's roll.
      const [qx, qy, qz, qw] = fromYawPitchRoll(s.yawAngle, -s.look, s.tilt.roll * 0.15);
      camQ.set(qx, qy, qz, qw);
      uptilt.identity();
    }
    camera.quaternion.copy(camQ).multiply(uptilt);
  }

  /** The fly-in. Returns false once it's over. */
  function playIntro(now: number, s: DroneState): boolean {
    const i = intro.current;
    if (i.start < 0) i.start = now;
    const t = (now - i.start) / 1000;
    const g = useGame.getState();
    if (t >= INTRO_END) {
      const fog = scene.fog as THREE.Fog | null;
      if (fog) [fog.near, fog.far] = FOG;
      g.set({ intro: false, breakup: 0 });
      resetSticks();
      return false;
    }
    if (i.whooshed < WHOOSHES.length && t >= WHOOSHES[i.whooshed]) {
      whoosh(i.whooshed === WHOOSHES.length - 1 ? 0.35 : 0.5);
      i.whooshed++;
    }
    const p = s.pos;
    const [lx, ly, lz, lw] = fromYawPitchRoll(s.yawAngle, Math.PI / 2, 0);
    lookDown.set(lx, ly, lz, lw);
    let h = H2 * 0.95;
    let fx = 0;
    const shot = SHOTS.find(([a, b]) => t >= a && t < b);
    if (shot) {
      const [a, b, kind, from, to] = shot;
      const u = (t - a) / (b - a);
      h = kind === "drop" ? from + (to - from) * ease(u) : from + (to - from) * u;
      fx = kind === "drop" ? 0.55 * Math.sin(Math.PI * u) : 0;
      camera.position.set(p[0], p[1] + h, p[2]);
      camera.quaternion.copy(lookDown);
    } else {
      // Final swoop: drop the last stretch and swing from looking down to the drone's own camera.
      placeCamera(s, p, g.thirdPerson);
      const end = camera.position.clone();
      const endQ = camera.quaternion.clone();
      const u = (t - SWOOP_START) / (INTRO_END - SWOOP_START);
      const k = ease(u);
      camera.position.set(p[0] + (end.x - p[0]) * k, p[1] + h + (end.y - p[1] - h) * k, p[2] + (end.z - p[2]) * k);
      camera.quaternion.copy(lookDown).slerp(endQ, ease(Math.min(1, u * 1.15)));
      fx = 0.3 * Math.sin(Math.PI * u);
      h = camera.position.y - p[1];
    }
    // Fog is tuned for street level; push it out while we're up high.
    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = Math.max(FOG[0], h * 0.85);
      fog.far = Math.max(FOG[1], h + 1800);
    }
    if (Math.abs(fx - g.breakup) > 0.03) g.set({ breakup: fx });
    return true;
  }

  useFrame((_, rawDt) => {
    const col = collider.current;
    if (!col) return;
    const dt = Math.min(rawDt, 1 / 20);
    const g = useGame.getState();
    const now = performance.now();

    if (g.intro && playIntro(now, drone.current)) {
      model.current?.position.set(...drone.current.pos);
      session.world.sendPose(drone.current.pos, drone.current.quat, now);
      readSticks(dt);
      readMouse();
      return;
    }

    let crashed = now < crashUntil.current;
    const cfg = settings();
    const sticks = readSticks(dt);
    const mouse = readMouse();
    // While the video is out after a crash the quad hangs at hover (and respawns upright).
    const input = crashed ? { throttle: hoverThrottle(cfg), yaw: 0, pitch: 0, roll: 0 } : sticks;

    const angle = cfg.mode === "angle";
    const moving = angle && (Math.abs(input.pitch) > MOVE_STICK || Math.abs(input.roll) > MOVE_STICK);
    if (landed.current && (input.throttle > takeoffThrottle(cfg) || moving)) landed.current = false;
    const prev = drone.current.pos;
    let state: DroneState;
    let move: Vec3;
    if (landed.current) {
      let s = drone.current;
      if (angle && !g.settingsOpen) {
        // Sitting on a roof you can still look around.
        const { state: looked } = step(s, { ...input, pitch: 0, roll: 0, throttle: 0.5 }, dt, cfg, mouse);
        s = { ...s, yawAngle: looked.yawAngle, look: looked.look };
      }
      state = settle(s, dt, angle);
      move = [0, -0.02, 0]; // stay in contact
    } else {
      ({ state, move } = step(drone.current, input, dt, cfg, crashed || g.settingsOpen ? undefined : mouse));
    }
    if (hop.current) {
      move = [move[0], move[1] + hop.current, move[2]];
      hop.current = 0;
    }

    col.setTranslation({ x: prev[0], y: prev[1], z: prev[2] });
    controller.computeColliderMovement(col, { x: move[0], y: move[1], z: move[2] });
    const m = controller.computedMovement();
    let pos: Vec3 = [prev[0] + m.x, prev[1] + m.y, prev[2] + m.z];
    let vel = state.vel;
    let lost = Math.hypot(move[0] - m.x, move[1] - m.y, move[2] - m.z) / dt;
    let hit = controller.numComputedCollisions() > 0;

    // Belt and braces against tunnelling: the centre must never cross a surface in one frame.
    const seg: Vec3 = [pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]];
    const len = Math.hypot(...seg);
    if (len > 1e-4) {
      const dir = { x: seg[0] / len, y: seg[1] / len, z: seg[2] / len };
      const through = rw.castRay(new rapier.Ray({ x: prev[0], y: prev[1], z: prev[2] }, dir), len, true, undefined, undefined, col);
      if (through) {
        const back = Math.max(0, through.timeOfImpact - RADIUS);
        pos = [prev[0] + dir.x * back, prev[1] + dir.y * back, prev[2] + dir.z * back];
        lost = Math.max(lost, speed(vel));
        hit = true;
      }
    }
    if (hit && !landed.current) {
      vel = [(pos[0] - prev[0]) / dt, (pos[1] - prev[1]) / dt, (pos[2] - prev[2]) / dt];
      if (lost > CRASH_SPEED && !crashed) {
        crashUntil.current = now + 1400;
        g.set({ crashedAt: now });
        burst(1, 900);
        session.world.crash(lost);
        crashed = true;
      }
    }

    // Fell out of the world anyway: put it back on top of whatever is below.
    if (pos[1] < floor - 1) {
      const down = rw.castRay(new rapier.Ray({ x: pos[0], y: 600, z: pos[2] }, { x: 0, y: -1, z: 0 }), 1200, true, undefined, undefined, col);
      const top = down ? 600 - down.timeOfImpact : -Infinity;
      pos = top > floor - 0.5 ? [pos[0], top + 2, pos[2]] : [...session.spawn];
      vel = [0, 0, 0];
      landed.current = false;
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

    // Touchdown: something solid right under the props, upright, settling, not powering away.
    const below = rw.castRayAndGetNormal(new rapier.Ray({ x: pos[0], y: pos[1], z: pos[2] }, { x: 0, y: -1, z: 0 }), RADIUS + 0.15, true, undefined, undefined, col);
    const ground = !!below && below.normal.y > 0.7;
    if (landed.current && !ground) landed.current = false;
    else if (!landed.current && ground && !crashed) {
      const up = rotate(state.quat, [0, 1, 0]);
      if (up[1] > 0.5 && vel[1] <= 0.5 && Math.hypot(vel[0], vel[2]) < LAND_MAX_SIDEWAYS && input.throttle < takeoffThrottle(cfg) && !moving) {
        landed.current = true;
        vel = [0, 0, 0];
        state = { ...state, rate: [0, 0, 0] };
      }
    }
    if (landed.current) vel = [0, 0, 0];

    drone.current = { ...state, pos, vel };
    col.setTranslation({ x: pos[0], y: pos[1], z: pos[2] });

    const [qx, qy, qz, qw] = drone.current.quat;
    tmpQ.set(qx, qy, qz, qw);
    model.current?.quaternion.copy(tmpQ);
    model.current?.position.set(pos[0], pos[1], pos[2]);
    placeCamera(drone.current, pos, g.thirdPerson);
    if (model.current) model.current.visible = g.thirdPerson;

    // analog video breakup: close to walls, beyond the map edge, right after a crash
    let nearest = 8;
    for (const dir of PROBES) {
      const d = rotate(drone.current.quat, dir);
      const h = rw.castRay(new rapier.Ray({ x: pos[0], y: pos[1], z: pos[2] }, { x: d[0], y: d[1], z: d[2] }), 8, true, undefined, undefined, col);
      if (h && h.timeOfImpact < nearest) nearest = h.timeOfImpact;
    }
    // Sitting on the ground isn't flying into a wall.
    const wall = landed.current ? 0 : Math.max(0, 1 - nearest / 6) ** 2;
    const edge = Math.max(0, (r - MAP_LIMIT * 0.8) / (MAP_LIMIT * 0.2));
    const crashFx = crashed ? (crashUntil.current - now) / 1400 : 0;
    const breakup = Math.min(1, Math.max(wall * 0.8, edge, crashFx));

    // network + audio listener
    session.world.sendPose(pos, drone.current.quat, now);
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const inRange = session.voice?.updateSpatial(
      { pos: [camera.position.x, camera.position.y, camera.position.z], fwd: [camFwd.x, camFwd.y, camFwd.z], up: [camUp.x, camUp.y, camUp.z] },
      session.positions,
    );

    if (now - lastUi.current > 100) {
      lastUi.current = now;
      g.set({ throttle: input.throttle, speed: speed(vel), altitude: pos[1], breakup, inRange: inRange ?? 0, pilots: session.world.humans + 1, escorts: session.world.myEscorts, landed: landed.current });
    } else if (Math.abs(breakup - g.breakup) > 0.05) {
      g.set({ breakup });
    }
  });

  return (
    <group ref={model} scale={MODEL_SCALE}>
      <DroneModel led="#3fa7ff" tx={useGame((s) => s.ptt === "on")} />
    </group>
  );
}
