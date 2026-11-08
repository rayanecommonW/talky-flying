import { useEffect, useState } from "react";

export type CityMeta = { name: string; bounds: { min: [number, number, number]; max: [number, number, number] } };

/** Does the Blender-built city exist? Otherwise we fly a procedural blockout so the game always runs. */
export function useCityMeta(): CityMeta | null | undefined {
  const [meta, setMeta] = useState<CityMeta | null | undefined>(undefined);
  useEffect(() => {
    fetch("/city/meta.json")
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);
  return meta;
}
