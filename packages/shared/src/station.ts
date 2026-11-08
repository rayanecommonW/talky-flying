import { z } from "zod";

export const STATION_FORMATS = [
  "talk",
  "call-in",
  "qna",
  "advice",
  "traffic",
  "news",
  "conspiracy",
  "sports",
  "music-pirate",
  "dispatch",
  "classifieds",
  "late-night",
] as const;

/** Provider-agnostic voice archetypes; the radio agent maps them to real TTS voices. */
export const VOICE_ARCHETYPES = [
  "gravel_male",
  "warm_male",
  "young_male",
  "british_male",
  "warm_female",
  "smoky_female",
  "bright_female",
  "british_female",
] as const;

export const StationBible = z.object({
  dial: z.number().int(),
  name: z.string().min(2).max(60),
  slogan: z.string().max(140),
  format: z.enum(STATION_FORMATS),
  host: z.object({
    name: z.string().min(2).max(40),
    persona: z.string().min(10).max(800),
    quirks: z.array(z.string().max(200)).max(8),
    voice: z.enum(VOICE_ARCHETYPES),
  }),
  topics: z.array(z.string().max(200)).min(1).max(12),
  recurringBits: z.array(z.string().max(200)).max(8),
  bannedTopics: z.array(z.string().max(120)).max(12),
  worldFeed: z.boolean(),
  curated: z.boolean().default(false),
});
export type StationBible = z.infer<typeof StationBible>;

/** What a client needs to render the radio display. */
export type StationCard = Pick<StationBible, "dial" | "name" | "slogan" | "format" | "curated"> & {
  host: string;
  onAir: boolean;
  listeners: number;
};

export function toCard(b: StationBible, onAir: boolean, listeners: number): StationCard {
  return { dial: b.dial, name: b.name, slogan: b.slogan, format: b.format, curated: b.curated, host: b.host.name, onAir, listeners };
}
