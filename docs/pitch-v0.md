# Pitch v0 (pre-grill)

Drone pilot in a Blender-authored city, first person. The radio is the game.

- Default frequency = spatial proximity chat. Long-range channels = range at the cost of proximity. "The dial decides what you don't hear."
- Channels have culture: control tower, pirate broadcast, emergency net. Each has its own audio filter.
- AI drones have their own goals, emit cheap procedural ambient chatter driven by game state; live LLM conversation only when the player initiates.
- Fixed identity + memory the conversation can't rewrite. The radio fiction (squelch, "standby") hides LLM latency.

Proposed tech: authoritative fixed-tick server (clients send intent), WebSocket control plane, WebRTC SFU where audible-set = subscription permissions, Web Audio PannerNode spatialization client-side, AI as a side-channel that degrades gracefully, Blender visual mesh + simplified collision mesh.

5h slice: two browser clients in one scene, server-computed audible set, panned voice, channel switch that cuts the near voice and lets a far one through, one scripted AI drone that rumbles until you talk to it.
