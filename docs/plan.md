# DEAD AIR — final plan

Working title. Planning only, no code yet. This replaces `plan-v1.md`.

## 1. The product

You fly an FPV drone over a post-war city. Your drone has a radio with two modes:

- **LOCAL**: open air, proximity voice. You hear pilots near you, positioned in 3D. Push to talk.
- **FM 87.5–108.0** (206 frequencies, 0.1 MHz steps): city-wide range, and you can't hear LOCAL. Every frequency can host a station: a live AI radio show (talk radio, call-in, Q&A, late-night advice, traffic report, conspiracy hour…). The show starts when the first listener tunes in, freezes when the last one leaves, and resumes where it stopped. Push to talk on FM = you're a caller: "Caller, you're on the air."

The trade: LOCAL tells you what's around you, FM tells you what's going on in the city, and you can't have both.

There are no AI drones and no logins. Each pilot gets a random callsign (e.g. `KESTREL-7`) stored in `localStorage`.

## 2. Architecture

```
                         Vercel (static)
                    ┌───────────────────────┐
  Browser ─────────▶│ apps/web  (Vite SPA)  │
     │              └───────────────────────┘
     │  wss (Colyseus)         WebRTC (LiveKit)
     ▼                              ▼
┌─────────────────────── Nebius VM (docker compose) ────────────────────────┐
│  caddy (TLS)                                                              │
│  ├── apps/game   Node 24 + Colyseus 0.18                                  │
│  │     WorldRoom: poses, dial, floor control, presence                    │
│  │     HTTP: /session (callsign + LiveKit token), /stations, /world       │
│  │     StationService: lazy station generation (LLM), show state          │
│  │     SQLite (WAL, Drizzle) ── the only durable store                    │
│  ├── livekit-server (OSS SFU, built-in TURN)                              │
│  │     rooms: "local", "fm-1043", "fm-0899", …                            │
│  └── apps/radio  Python + LiveKit Agents                                  │
│        one host agent per on-air station room                             │
│        LLM: Claude (live host)  ·  TTS/STT: ElevenLabs (or Kokoro/Whisper)│
└───────────────────────────────────────────────────────────────────────────┘
```

Three runtime planes, deliberately separate:

| Plane | Carries | Tech | Rate |
|---|---|---|---|
| Control | poses, dial changes, PTT floor requests, presence | Colyseus over WebSocket | 20 Hz |
| Voice | mic audio, host audio | LiveKit (WebRTC SFU) | continuous |
| Durable | stations, show state, transcripts | SQLite, owned by `apps/game` | a few writes/min |

The AI sits beside the voice plane, never in front of it. If the radio agent dies, LOCAL voice and flying still work and stations just go to static.

## 3. Key decisions and why

### Voice: self-hosted LiveKit + LiveKit Agents (not Pipecat)

Pipecat is an agent framework, not a voice server. You still need something that takes one host's audio and fans it out to every listener on 98.3. Pipecat's own WebRTC transport is one-to-one, and for rooms it plugs into Daily (hosted) or… LiveKit. So the real choice is between two agent frameworks on top of an SFU, and the SFU is LiveKit either way.

- LiveKit server is open source (Apache 2.0), a single Go binary with built-in TURN, and you can self-host it, which you said you prefer.
- LiveKit Agents joins a room as a normal participant and supports automatic dispatch when a room is created. That gives us "first listener starts the show" for free.
- Pipecat's multi-party support has known sync issues, according to comparison write-ups.

### Movement: client-authoritative, server-validated

FPV needs zero input lag, and drones don't collide with each other. Each client simulates its own drone (Rapier against the city collision mesh) and sends its pose at 20 Hz. The server rejects impossible moves (speed cap, teleport check) and broadcasts. Remote drones are interpolated 100 ms behind using Colyseus 0.18's built-in interpolation, with `@geckos.io/snapshot-interpolation` as the fallback (it supports quaternion slerp). If a gameplay reason for server authority ever appears, Colyseus 0.18 already has prediction and reconciliation.

### Data: SQLite now, Redis later. No "realtime DB", no TanStack Start

- 20 Hz positions don't belong in a database. Colyseus is already the realtime layer.
- What's durable is small and slow (stations, show state, transcripts), so SQLite on the VM is enough, with one owner (`apps/game`). The Python agent reads and writes through internal HTTP, not the DB file.
- Redis comes in only when scaling out (section 8): Colyseus presence and driver across processes, plus the station lock.
- Frontend: a plain Vite + React SPA. TanStack Start's SSR and server functions buy nothing for a WebGL canvas and two fetches. It ships as static files on Vercel.

### Floor control (half-duplex)

- **FM:** one talker at a time. `WorldRoom.floor[freq]` holds the caller's sessionId. PTT press → `requestFloor` → granted: the client unmutes its mic. Busy: the client plays a busy blip and nothing is sent. Release or 30 s timeout → floor freed, and the caller hears a roger beep.
- **LOCAL:** PTT, but no floor. Several nearby pilots can talk at once, like open air.
- The agent doesn't need voice-activity detection: the caller's mic track unmute/mute events in LiveKit are the exact turn boundaries. PTT gives us turn-taking for free.

## 4. Radio stations

### Station lifecycle

```
tune to 98.3
  └─ GET /stations/983
       ├─ exists → join LiveKit room "fm-0983"
       └─ missing → claim lock → LLM generates the station bible (JSON schema) → save → join
room "fm-0983" created → LiveKit auto-dispatches the host agent
  agent loads bible + show_state → "…and we're back" or the cold open
  loop: write next segment (one ahead) → TTS stream → save show_state per segment
caller takes the floor (mic unmuted)
  → cut the TTS queue → sting "we've got a caller" → STT the caller
caller releases → LLM replies in character → TTS → resume the segment plan
room empty for 20 s → agent saves show_state, exits (freeze)
```

### Station bible (generated once, then fixed)

`{ freq, name, slogan, format (talk|call-in|qna|advice|traffic|news|conspiracy|sports), host: { name, persona, quirks, voiceId }, topics[], recurringBits[], bannedTopics[], world_feed: bool }`

- About 10 hand-curated stations are seeded. Claude writes them offline, and they live in the repo as JSON.
- The other ~196 frequencies are generated on first tune by a cheap model (Nebius `Qwen/Qwen3-30B-A3B-Instruct-2507`, structured JSON). A post-war city has a lot of stations: rebuild bulletins, black-market classifieds, a dispatcher who never sleeps, a pirate DJ.
- While a station is being generated, the radio plays static and "signal acquiring…".

### The world feeds the shows

Stations with `world_feed: true` get `GET /world` (pilot count, busy districts, landmarks, who's flying recklessly, who just crashed). This is where the AI stops being a podcast and becomes part of the game: "Heavy traffic over the cathedral ruins, three drones circling. KESTREL-7, I see you."

### Models

| Job | Model | Why |
|---|---|---|
| Live host segments and caller replies | Claude (Haiku-class for latency, Sonnet-class for the best stations) | Personality, tone, speed |
| Station generation, summaries | Nebius Qwen3-30B-A3B | Cheap, OpenAI-compatible, limited credit |
| TTS | ElevenLabs streaming (one voice per host) | Best voices; needs `ELEVENLABS_API_KEY` |
| STT (callers) | ElevenLabs Scribe, or faster-whisper self-hosted | Clean turns thanks to PTT |
| Free fallback | Kokoro-FastAPI (TTS) + faster-whisper (STT) on the VM | Fully self-hosted, no voice API bill |

### Cost guards

- An agent runs only while a station has listeners.
- `MAX_ON_AIR` (e.g. 8) concurrent live stations. Past that, a station plays "technical difficulties" static plus a pre-rendered ident.
- Segments are buffered one ahead and capped in length. The rolling summary stops the context from growing without bound.
- Rough sizing: one hour of continuous talk ≈ 9k words ≈ 55k TTS characters per live station.

## 5. Client

- **Stack:** Vite, React, `@react-three/fiber`, `@react-three/drei` (Sky, Clouds, PositionalAudio, loaders), `@react-three/rapier`, `@react-three/postprocessing`, `zustand`, `colyseus.js`, `livekit-client`.
- **Flight:** angle mode by default, acro as a toggle, Betaflight-style rate curves. Keyboard + mouse, plus the Gamepad API (real FPV radios, EdgeTX/OpenTX, show up as USB gamepads). Crash = bounce, video breakup, respawn.
- **FPV look:** wide FOV, camera uptilt, analog video post-processing (grain, chroma noise, tearing) that gets worse near walls and at the map edge.
- **Spatial voice (LOCAL):** `autoSubscribe: false`. Subscribe to a pilot within R, unsubscribe beyond 1.2R (hysteresis). Each remote track goes through a muted `<audio>` element (Chrome workaround) → `MediaStreamSource` → `PannerNode` (HRTF) attached to that drone, updated every frame.
- **Radio sound:** each band has its own Web Audio chain: bandpass 300–3400 Hz, waveshaper grit, noise bed, squelch tail and roger beep on release. Tuning plays static that sweeps with the dial.
- **HUD:** analog dial (scroll / Q-E to tune, presets 1–9), station name + host on the display, signal meter, a TX light while you hold PTT, a busy light when the floor is taken, and who's talking nearby.

## 6. The city

- **Real layout, fictional name:** an OpenStreetMap extract (~1×1 km of a European old town) imported with Blosm (free, base version). The city gets a made-up name, e.g. "Port Ardent", so we never show a real city destroyed. OSM data is ODbL, so attribution goes in the README.
- **Post-war pass:** a headless Blender Python script (`blender -b -P tools/city/build.py`, Blender is installed locally): collapsed upper floors, boolean bomb holes, rubble scatter, scorched materials, broken windows, craters, burned vehicles, scaffolding. Then outskirts terrain, a river and a bridge. Overcast sky, fog and drei clouds in the client.
- **Assets:** CC0 only (Poly Haven textures, Kenney and Quaternius props).
- **Exports:** `city.glb` (visual, meshopt + KTX2 via gltf-transform) and `city_collision.glb` (a box or convex hull per building, ground plane). The client builds Rapier colliders from the collision file only.

## 7. Repo layout

```
walkie-talkie-drones/
  AGENTS.md
  apps/
    web/          Vite + R3F client (Vercel)
    game/         Colyseus server + HTTP + StationService + SQLite
    radio/        Python LiveKit Agents worker (uv)
  packages/
    shared/       TS types: protocol messages, schemas, station bible zod schema
  stations/       curated station bibles (JSON)
  tools/city/     Blender scripts, OSM extract, export pipeline
  infra/          docker-compose.yml, livekit.yaml, Caddyfile
  docs/
```

pnpm workspaces for TS, uv for Python.

## 8. Scaling (README section, not built)

| Bottleneck | First fix | Next |
|---|---|---|
| One WorldRoom (all poses) | Spatial hash for interest management, so each client only gets poses near it + per-station listener counts | Shard the city into cell rooms, with Redis presence across Colyseus processes |
| LOCAL voice room size | Selective subscription (already) | One LiveKit room per city cell; pilots join the neighboring cells' rooms near borders |
| A big station (1000 listeners) | One forwarded host track; the SFU fan-out is cheap | LiveKit multi-node / cascading, or a re-broadcast to an HLS stream for passive listeners |
| AI cost | `MAX_ON_AIR`, listener-gated agents | Pre-rendered segments shared by stations nobody calls into |
| SQLite | Fine for one VM | Postgres when there's more than one game node |

Daytona sandboxes can run N headless bot clients (fake pilots flying paths, playing recorded audio) as a load-test harness.

## 9. Deploy

- **Vercel:** `apps/web` only (static build). Env: `VITE_GAME_URL`, `VITE_LIVEKIT_URL`.
- **Nebius VM** (CPU, ~4–8 vCPU, public IP): docker compose with caddy, game, livekit-server, radio, and optionally kokoro/whisper. Ports: 443 (https/wss/TURN-TLS), 7881/tcp, 50000–60000/udp, 3478/udp.
- Needs a domain with two records (e.g. `game.` and `lk.`).
- Nothing gets created on Nebius without your go-ahead.

## 10. Build order

1. Scaffold the monorepo + local `docker compose` (LiveKit in dev mode).
2. Fly: placeholder blockout city, flight model, collisions, FPV camera.
3. World: Colyseus room, pose sync, interpolated remote drones, callsigns.
4. LOCAL voice: LiveKit, PTT, selective subscription, HRTF panning, radio FX.
5. Dial: FM rooms, tuning static, floor control, busy/roger beeps.
6. One curated station end to end: monologue loop + caller turn.
7. Dynamic stations: lazy generation, persistence, freeze/resume, cost cap, world feed.
8. City: OSM + post-war Blender pipeline, swap out the blockout.
9. Polish: analog FPV FX, HUD, gamepad.
10. README: architecture diagram, decisions, scaling, LLM usage. Then deploy.

## 11. Open-source used or referenced

- Netcode: [Colyseus 0.18](https://colyseus.io/blog/colyseus-018-is-here/), [@geckos.io/snapshot-interpolation](https://www.npmjs.com/package/@geckos.io/snapshot-interpolation)
- Voice: LiveKit server, `livekit-client`, [LiveKit Agents](https://github.com/livekit/agents-js) (Python version), [Kokoro via LiveKit](https://docs.livekit.io/agents/models/tts/kokoro), faster-whisper
- 3D: three.js, R3F, drei, @react-three/rapier, postprocessing, gltf-transform, [Blosm](https://github.com/vvoovv/blosm)
- References to read, not copy: [WebFPVSimulator](https://github.com/Mathew-Harvey/WebFPVSimulator/wiki) (Betaflight in WASM, flight feel), [josepedrodias/fpv](https://awesome.ecosyste.ms/projects/github.com%2Fjosepedrodias%2Ffpv) (gamepad radios), [CS2 VoiceProximity](https://gh.ali360.cloudns.ch/b0ink/CS2-VoiceProximity-Client) (three.js voice occlusion and reverb), [auproximity](https://github.com/edqx/auproximity) (GPL, ideas only)

## 12. Still needed from you

1. `ELEVENLABS_API_KEY`, or the go-ahead for the fully self-hosted Kokoro + Whisper voice.
2. A domain for the VM.
3. Which town's street layout (or I pick one).
