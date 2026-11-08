/** The hand-written stations, bundled so the start screen dial works even before the server answers. */
import type { StationCard } from "@dead-air/shared";

type Bible = { dial: number; name: string; slogan: string; format: string; host: { name: string } };

const files = import.meta.glob<Bible>("../../../../stations/*.json", { eager: true, import: "default" });

export const CURATED: StationCard[] = Object.values(files)
  .map((b) => ({ dial: b.dial, name: b.name, slogan: b.slogan, format: b.format, host: b.host.name, curated: true, onAir: false, listeners: 0 }) as StationCard)
  .sort((a, b) => a.dial - b.dial);
