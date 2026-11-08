import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { config } from "./config.ts";

export const RADIO_AGENT_NAME = "radio-host";
/** ParticipantInfo.Kind.AGENT in the LiveKit protocol. */
const KIND_AGENT = 4;
/** A dispatch with no agent in the room after this long is considered stuck and replaced. */
const DISPATCH_STALE_MS = 15_000;

function httpUrl(ws: string): string {
  return ws.replace(/^ws/, "http");
}

export class Voice {
  private rooms = new RoomServiceClient(httpUrl(config.livekitUrl), config.livekitApiKey, config.livekitApiSecret);
  private dispatch = new AgentDispatchClient(httpUrl(config.livekitUrl), config.livekitApiKey, config.livekitApiSecret);
  private lastDispatchAt = new Map<string, number>();

  async token(identity: string, name: string, room: string): Promise<string> {
    const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, { identity, name, ttl: "6h" });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: true });
    return at.toJwt();
  }

  async hasAgent(room: string): Promise<boolean> {
    try {
      const ps = await this.rooms.listParticipants(room);
      return ps.some((p) => p.kind === KIND_AGENT || p.identity.startsWith("agent-"));
    } catch {
      return false; // room does not exist yet
    }
  }

  /**
   * Make sure the radio host is (or will shortly be) in the room. Explicit dispatch creates the
   * room if needed, so the show can be warming up before the first listener finishes connecting.
   */
  async ensureHost(room: string, dial: number): Promise<"present" | "dispatched" | "pending"> {
    if (await this.hasAgent(room)) return "present";
    const existing = await this.dispatch.listDispatch(room).catch(() => []);
    const last = this.lastDispatchAt.get(room) ?? 0;
    if (existing.length > 0 && Date.now() - last < DISPATCH_STALE_MS) return "pending";
    for (const d of existing) await this.dispatch.deleteDispatch(d.id, room).catch(() => {});
    await this.dispatch.createDispatch(room, RADIO_AGENT_NAME, { metadata: JSON.stringify({ dial }) });
    this.lastDispatchAt.set(room, Date.now());
    return "dispatched";
  }
}
