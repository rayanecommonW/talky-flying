import fs from "node:fs";
import path from "node:path";

export type Landmark = { id: string; name: string; x: number; y: number; z: number; radius: number };

/** Landmarks come from the city build. Reloaded when the file changes so the server never needs a restart. */
export class Landmarks {
  private list: Landmark[] = [];
  private mtime = 0;

  constructor(private file: string) {}

  all(): Landmark[] {
    try {
      const m = fs.statSync(this.file).mtimeMs;
      if (m !== this.mtime) {
        this.list = JSON.parse(fs.readFileSync(this.file, "utf8")) as Landmark[];
        this.mtime = m;
      }
    } catch {
      /* no city yet */
    }
    return this.list;
  }

  /** Nearest landmark on the ground plane, within 2x its radius. */
  near(x: number, z: number): Landmark | null {
    let best: Landmark | null = null;
    let bestD = Infinity;
    for (const l of this.all()) {
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < l.radius * 2 && d < bestD) {
        best = l;
        bestD = d;
      }
    }
    return best;
  }

  static fromCityDir(dir: string): Landmarks {
    return new Landmarks(path.join(dir, "landmarks.json"));
  }
}

export function loadSpawns(dir: string): [number, number, number][] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "spawns.json"), "utf8")) as { x: number; y: number; z: number }[];
    if (raw.length) return raw.map((s) => [s.x, s.y, s.z]);
  } catch {
    /* fall through */
  }
  return [
    [0, 40, 0],
    [30, 40, 30],
    [-30, 40, -30],
    [60, 45, -20],
  ];
}
