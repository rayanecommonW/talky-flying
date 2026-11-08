import { schema, t, type SchemaType } from "@colyseus/schema";

export const Pilot = schema({
  callsign: t.string(),
  x: t.number().default(0),
  y: t.number().default(0),
  z: t.number().default(0),
  qx: t.number().default(0),
  qy: t.number().default(0),
  qz: t.number().default(0),
  qw: t.number().default(1),
  /** 0 = LOCAL, otherwise FM in tenths of MHz. */
  dial: t.number().default(0),
  /** Transmitting right now (holding the floor on FM, or keyed up on LOCAL). */
  tx: t.boolean().default(false),
  /** Escort drones: sessionId of the pilot this one follows. Empty for real pilots. */
  owner: t.string().default(""),
});
export type Pilot = SchemaType<typeof Pilot>;

export const WorldState = schema({
  pilots: t.map(Pilot),
  /** FM dial (as string) -> sessionId of the caller holding the floor. */
  floors: t.map("string"),
});
export type WorldState = SchemaType<typeof WorldState>;
