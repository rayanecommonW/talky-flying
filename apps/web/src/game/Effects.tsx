import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { ChromaticAberration, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction, type ChromaticAberrationEffect, type NoiseEffect } from "postprocessing";
import * as THREE from "three";
import { useGame } from "../state/store.ts";

/** Analog FPV video: grain always, plus chroma smear and heavy noise when the link degrades. */
export function Effects() {
  const noise = useRef<NoiseEffect>(null);
  const chroma = useRef<ChromaticAberrationEffect>(null);
  const offset = useRef(new THREE.Vector2(0.0006, 0.0004));

  useFrame(() => {
    const b = useGame.getState().breakup;
    const jitter = b > 0.05 ? (Math.random() - 0.5) * b * 0.02 : 0;
    if (noise.current) noise.current.blendMode.opacity.value = 0.09 + b * 0.75;
    offset.current.set(0.0006 + b * 0.012 + jitter, 0.0004 + b * 0.004);
    if (chroma.current) chroma.current.offset = offset.current;
  });

  return (
    <EffectComposer multisampling={0}>
      <ChromaticAberration ref={chroma} offset={offset.current} radialModulation={false} modulationOffset={0} />
      <Noise ref={noise} premultiply blendFunction={BlendFunction.SCREEN} opacity={0.09} />
      <Vignette eskil={false} offset={0.25} darkness={0.75} />
    </EffectComposer>
  );
}
