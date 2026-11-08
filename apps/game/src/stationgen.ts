import OpenAI from "openai";
import { dialLabel, STATION_FORMATS, StationBible, VOICE_ARCHETYPES } from "@dead-air/shared";

/** Small deterministic PRNG so a frequency always falls back to the same station. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

export const WORLD_BRIEF = `Port Ardent is a river city on the far side of a long war. The front moved on two winters ago.
The old town is half rubble: collapsed upper floors, bomb holes, craters in the squares, canals full of wreckage.
People are rebuilding. Power is rationed, bread queues are long, the black market runs on batteries and drone parts.
The sky is full of FPV drone pilots (couriers, scavengers, scouts, kids) and every drone carries a radio.
Radio is how the city talks: dozens of tiny stations broadcast from basements and bell towers on FM 87.5 to 108.0.
Tone: wry, humane, darkly funny, never gory, never cruel. Real places in town include the Belfry Ruins, the Cathedral,
Castle Gravensteen, the Drowned Quay, the Market Square crater, and the North Rail Yards.`;

const FORMAT_HINT: Record<(typeof STATION_FORMATS)[number], string> = {
  talk: "a talk show host riffing on one theme with strong opinions",
  "call-in": "a call-in show that lives for listeners keying up",
  qna: "an expert answering questions from callers",
  advice: "late-night advice for the lonely and the stubborn",
  traffic: "drone traffic and airspace reports for the city",
  news: "a scrappy rebuild news bulletin",
  conspiracy: "a conspiracy theorist with absurd, harmless theories",
  sports: "a sports commentator who treats drone flying as a sport",
  "music-pirate": "a pirate DJ who describes records they can't play because the turntable is broken",
  dispatch: "a bored civil-defence dispatcher reading procedure and gossip",
  classifieds: "barter and black-market classifieds read out loud",
  "late-night": "a slow late-night monologue about the city",
};

const NAME_A = ["Rubble", "Ember", "Lantern", "Static", "Canal", "Belfry", "Ration", "Ash", "Brick", "Night", "Signal", "Rust"];
const NAME_B = ["Radio", "FM", "Wire", "Hour", "Broadcast", "Frequency", "Hum", "Voice", "Line", "Relay"];
const HOSTS = ["Marta Vell", "Old Tomas", "Juno Brack", "Petra Kask", "Ivo Lenz", "Saskia Moor", "Dez Arden", "Hollis Crane", "Noor Feld", "Big Anouk"];

export function fallbackStation(dial: number): StationBible {
  const rand = mulberry32(dial * 7919);
  const format = pick(rand, STATION_FORMATS);
  const name = `${pick(rand, NAME_A)} ${pick(rand, NAME_B)} ${dialLabel(dial)}`;
  return StationBible.parse({
    dial,
    name,
    slogan: `${dialLabel(dial)}: still broadcasting.`,
    format,
    host: {
      name: pick(rand, HOSTS),
      persona: `Runs ${FORMAT_HINT[format]}. Broadcasts from a basement with a car battery and a stubborn transmitter.`,
      quirks: ["counts the seconds of battery left out loud", "calls every listener 'flyer'"],
      voice: pick(rand, VOICE_ARCHETYPES),
    },
    topics: ["the rebuild", "drone pilots overhead", "what the market has this week"],
    recurringBits: ["the battery count", "a weather report that is always 'grey'"],
    bannedTopics: ["graphic violence", "real-world politicians"],
    worldFeed: format === "traffic" || format === "sports" || format === "dispatch",
    curated: false,
  });
}

const SCHEMA_HINT = `{
  "name": string (2-60 chars, a radio station name, may include the frequency),
  "slogan": string (<= 140 chars),
  "format": one of ${JSON.stringify(STATION_FORMATS)},
  "host": {
    "name": string (2-40 chars),
    "persona": string (2-4 sentences: who they are, how they talk, what they want),
    "quirks": string[] (2-4 short verbal habits),
    "voice": one of ${JSON.stringify(VOICE_ARCHETYPES)}
  },
  "topics": string[] (4-8 specific recurring subjects),
  "recurringBits": string[] (2-4 named segments or running jokes),
  "bannedTopics": string[] (things this host refuses to discuss),
  "worldFeed": boolean (true only if the show comments on live drone traffic in the city)
}`;

export class StationGenerator {
  private client: OpenAI | null;

  constructor(
    baseURL: string | undefined,
    apiKey: string | undefined,
    private model: string,
  ) {
    this.client = baseURL && apiKey ? new OpenAI({ baseURL, apiKey, timeout: 20_000, maxRetries: 1 }) : null;
  }

  async generate(dial: number, neighbours: string[]): Promise<{ bible: StationBible; source: string }> {
    if (!this.client) return { bible: fallbackStation(dial), source: "fallback:no-llm" };
    const rand = mulberry32(dial * 104729);
    const format = pick(rand, STATION_FORMATS);
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.9,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You invent pirate and community radio stations for a game.\n\n${WORLD_BRIEF}\n\nReply with a single JSON object only, matching:\n${SCHEMA_HINT}`,
          },
          {
            role: "user",
            content: `Invent the station broadcasting on FM ${dialLabel(dial)}. Suggested format: ${format} (${FORMAT_HINT[format]}). Make it specific and funny, not generic. Stations already on nearby frequencies (don't repeat them): ${neighbours.join("; ") || "none"}.`,
          },
        ],
      });
      const raw = JSON.parse(res.choices[0]?.message?.content ?? "{}");
      const bible = StationBible.parse({ ...raw, dial, curated: false });
      return { bible, source: `llm:${this.model}` };
    } catch (err) {
      console.warn(`[stations] generation failed for ${dialLabel(dial)}, using fallback:`, (err as Error).message);
      return { bible: fallbackStation(dial), source: "fallback:error" };
    }
  }
}
