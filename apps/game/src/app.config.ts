import express, { type NextFunction, type Request, type Response } from "express";
import { defineRoom, defineServer, monitor } from "colyseus";
import { isFm, MAX_ESCORTS, toCard, WORLD_ROOM } from "@dead-air/shared";
import { config } from "./config.ts";
import { services } from "./services.ts";
import { WorldRoom } from "./rooms/WorldRoom.ts";

function internalOnly(req: Request, res: Response, next: NextFunction) {
  if (req.get("authorization") !== `Bearer ${config.internalToken}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  if (origin && (config.corsOrigins.includes("*") || config.corsOrigins.includes(origin))) {
    res.set("access-control-allow-origin", origin);
    res.set("vary", "origin");
  }
  next();
}

function dialParam(req: Request, res: Response): number | null {
  const dial = Number(req.params.dial);
  if (!isFm(dial)) {
    res.status(400).json({ error: "dial must be 875..1080" });
    return null;
  }
  return dial;
}

const seeded = services.stations.seedCurated(config.stationsDir);
console.log(`[stations] seeded ${seeded} curated stations`);

export default defineServer({
  rooms: {
    [WORLD_ROOM]: defineRoom(WorldRoom),
  },
  express: (app) => {
    app.use(express.json({ limit: "256kb" }));
    app.use("/api", cors);

    app.get("/api/health", (_req, res) => {
      res.json({ ok: true });
    });

    app.get("/api/stations", (_req, res) => {
      const feed = services.feed();
      res.json(services.stations.list().map((b) => toCard(b, true, feed.listenersByDial[(b.dial / 10).toFixed(1)] ?? 0)));
    });

    // --- internal routes for the radio agent ---
    app.get("/internal/stations/:dial", internalOnly, async (req, res) => {
      const dial = dialParam(req, res);
      if (dial === null) return;
      res.json(await services.stations.getOrCreate(dial));
    });

    app.get("/internal/show/:dial", internalOnly, (req, res) => {
      const dial = dialParam(req, res);
      if (dial === null) return;
      res.json({ state: services.store.getShowState(dial), transcript: services.store.recentTranscript(dial, 30) });
    });

    app.put("/internal/show/:dial", internalOnly, (req, res) => {
      const dial = dialParam(req, res);
      if (dial === null) return;
      const b = req.body ?? {};
      services.store.putShowState({
        dial,
        segment: Number(b.segment) || 0,
        summary: String(b.summary ?? "").slice(0, 4000),
        pendingLines: Array.isArray(b.pendingLines) ? b.pendingLines.map(String).slice(0, 40) : [],
        recentLines: Array.isArray(b.recentLines) ? b.recentLines.map(String).slice(-40) : [],
        updatedAt: Date.now(),
      });
      res.json({ ok: true });
    });

    app.post("/internal/transcript/:dial", internalOnly, (req, res) => {
      const dial = dialParam(req, res);
      if (dial === null) return;
      const { speaker, text } = req.body ?? {};
      if (typeof speaker === "string" && typeof text === "string" && text.trim()) {
        services.store.addTranscript(dial, speaker.slice(0, 40), text.slice(0, 2000));
      }
      res.json({ ok: true });
    });

    // A host sends escort drones to a caller (identity = the caller's sessionId).
    app.post("/internal/escort", internalOnly, (req, res) => {
      const { identity, count } = req.body ?? {};
      if (typeof identity !== "string") return void res.status(400).json({ error: "identity required" });
      const n = Math.max(1, Math.min(MAX_ESCORTS, Math.floor(Number(count) || 1)));
      const total = services.escort(identity, n);
      if (total === null) return void res.status(404).json({ error: "no such pilot" });
      res.json({ ok: true, total, max: MAX_ESCORTS });
    });

    app.get("/internal/world", internalOnly, (_req, res) => {
      res.json(services.feed());
    });

    if (process.env.NODE_ENV !== "production") app.use("/monitor", monitor());
  },
});
