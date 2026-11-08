import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { StationBible } from "@dead-air/shared";

export type ShowState = {
  dial: number;
  segment: number;
  summary: string;
  pendingLines: string[];
  recentLines: string[];
  updatedAt: number;
};

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stations (
        dial INTEGER PRIMARY KEY,
        bible TEXT NOT NULL,
        curated INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS show_state (
        dial INTEGER PRIMARY KEY REFERENCES stations(dial),
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dial INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        t INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcripts_dial_t ON transcripts(dial, t);
    `);
  }

  getStation(dial: number): StationBible | null {
    const row = this.db.prepare("SELECT bible FROM stations WHERE dial = ?").get(dial) as { bible: string } | undefined;
    return row ? StationBible.parse(JSON.parse(row.bible)) : null;
  }

  listStations(): StationBible[] {
    const rows = this.db.prepare("SELECT bible FROM stations ORDER BY dial").all() as { bible: string }[];
    return rows.map((r) => StationBible.parse(JSON.parse(r.bible)));
  }

  /** Curated stations are re-seeded on every boot so edits to stations/*.json take effect. */
  putStation(bible: StationBible, source: string): void {
    this.db
      .prepare(
        `INSERT INTO stations (dial, bible, curated, source, created_at) VALUES (@dial, @bible, @curated, @source, @t)
         ON CONFLICT(dial) DO UPDATE SET bible = excluded.bible, curated = excluded.curated, source = excluded.source`,
      )
      .run({ dial: bible.dial, bible: JSON.stringify(bible), curated: bible.curated ? 1 : 0, source, t: Date.now() });
  }

  getShowState(dial: number): ShowState | null {
    const row = this.db.prepare("SELECT state FROM show_state WHERE dial = ?").get(dial) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as ShowState) : null;
  }

  putShowState(state: ShowState): void {
    this.db
      .prepare(
        `INSERT INTO show_state (dial, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(dial) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(state.dial, JSON.stringify(state), state.updatedAt);
  }

  addTranscript(dial: number, speaker: string, text: string): void {
    this.db.prepare("INSERT INTO transcripts (dial, speaker, text, t) VALUES (?, ?, ?, ?)").run(dial, speaker, text, Date.now());
  }

  recentTranscript(dial: number, limit = 40): { speaker: string; text: string; t: number }[] {
    return (
      this.db
        .prepare("SELECT speaker, text, t FROM transcripts WHERE dial = ? ORDER BY t DESC, id DESC LIMIT ?")
        .all(dial, limit) as { speaker: string; text: string; t: number }[]
    ).reverse();
  }
}
