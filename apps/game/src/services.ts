import { config } from "./config.ts";
import { Store } from "./db.ts";
import { StationGenerator } from "./stationgen.ts";
import { StationService } from "./stations.ts";
import { Voice } from "./livekit.ts";
import { Landmarks, loadSpawns } from "./world.ts";
import type { WorldFeed } from "@dead-air/shared";

export type WorldEvent = WorldFeed["recentEvents"][number];

class Services {
  store = new Store(config.dbPath);
  stations = new StationService(this.store, new StationGenerator(config.nebiusBaseUrl, config.nebiusApiKey, config.stationModel));
  voice = new Voice();
  landmarks = Landmarks.fromCityDir(config.cityDir);
  spawns = loadSpawns(config.cityDir);
  events: WorldEvent[] = [];
  /** Set by the WorldRoom so HTTP routes can read live state. */
  feed: () => WorldFeed = () => ({ city: "Port Ardent", pilots: 0, listenersByDial: {}, hotspots: [], recentEvents: [] });

  pushEvent(e: WorldEvent): void {
    this.events.push(e);
    if (this.events.length > 30) this.events.shift();
  }
}

export const services = new Services();
