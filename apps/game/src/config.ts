import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const config = {
  port: num("PORT", 2567),
  livekitUrl: process.env.LIVEKIT_URL ?? "ws://localhost:7880",
  livekitPublicUrl: process.env.LIVEKIT_PUBLIC_URL ?? process.env.LIVEKIT_URL ?? "ws://localhost:7880",
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "devkey",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "secret",
  /** Shared secret for the radio agent's internal routes. */
  internalToken: process.env.INTERNAL_TOKEN ?? "dev-internal-token",
  dbPath: process.env.DB_PATH ?? path.join(REPO_ROOT, "data/dead-air.db"),
  stationsDir: process.env.STATIONS_DIR ?? path.join(REPO_ROOT, "stations"),
  cityDir: process.env.CITY_DIR ?? path.join(REPO_ROOT, "apps/web/public/city"),
  maxOnAir: num("MAX_ON_AIR", 8),
  nebiusBaseUrl: process.env.NEBIUS_BASE_URL,
  nebiusApiKey: process.env.NEBIUS_API_KEY,
  stationModel: process.env.STATION_MODEL ?? "Qwen/Qwen3-30B-A3B-Instruct-2507",
  corsOrigins: (process.env.CORS_ORIGINS ?? "*").split(","),
};
