import fs from "node:fs";
import path from "node:path";
import { dialLabel, isFm, StationBible } from "@dead-air/shared";
import type { Store } from "./db.ts";
import type { StationGenerator } from "./stationgen.ts";

export class StationService {
  private inflight = new Map<number, Promise<StationBible>>();

  constructor(
    private store: Store,
    private generator: StationGenerator,
  ) {}

  seedCurated(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const bible = StationBible.parse({ ...JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")), curated: true });
      this.store.putStation(bible, `curated:${file}`);
      n++;
    }
    return n;
  }

  get(dial: number): StationBible | null {
    return this.store.getStation(dial);
  }

  list(): StationBible[] {
    return this.store.listStations();
  }

  /** Every FM frequency has a station; it is invented the first time anyone tunes in. One generation per dial at a time. */
  async getOrCreate(dial: number): Promise<StationBible> {
    if (!isFm(dial)) throw new Error(`not an FM dial: ${dial}`);
    const existing = this.store.getStation(dial);
    if (existing) return existing;
    let p = this.inflight.get(dial);
    if (!p) {
      p = (async () => {
        const neighbours = this.store
          .listStations()
          .filter((s) => Math.abs(s.dial - dial) <= 30)
          .map((s) => `${dialLabel(s.dial)} ${s.name} (${s.format})`);
        const { bible, source } = await this.generator.generate(dial, neighbours);
        this.store.putStation(bible, source);
        console.log(`[stations] created ${dialLabel(dial)} "${bible.name}" via ${source}`);
        return bible;
      })().finally(() => this.inflight.delete(dial));
      this.inflight.set(dial, p);
    }
    return p;
  }
}
