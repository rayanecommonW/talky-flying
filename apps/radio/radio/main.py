"""LiveKit Agents worker: one radio host per on-air FM station room."""

from __future__ import annotations

import json
import logging

import httpx
from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, cli

from . import config
from .brain import Brain
from .game_api import GameApi
from .show import Show
from .speaker import Speaker
from .speech import TTS_SAMPLE_RATE, make_speech

log = logging.getLogger("radio")

def show_load(server: AgentServer) -> float:
    """Hosts are I/O-bound (LLM + TTS over HTTP). Measure load in shows, not host CPU, which
    would make the worker refuse jobs whenever something else on the machine is busy."""
    return min(1.0, len(server.active_jobs) / config.MAX_SHOWS_PER_WORKER)


server = AgentServer(load_fnc=show_load, load_threshold=0.99, num_idle_processes=2)


def dial_for(ctx: JobContext) -> int:
    try:
        return int(json.loads(ctx.job.metadata or "{}")["dial"])
    except (ValueError, KeyError, TypeError):
        return int(ctx.room.name.removeprefix("fm-"))


@server.rtc_session(agent_name="radio-host")
async def radio_host(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    dial = dial_for(ctx)
    http = httpx.AsyncClient(timeout=30)
    ctx.add_shutdown_callback(http.aclose)

    api = GameApi(http)
    bible = await api.station(dial)
    tts, stt = make_speech(http)
    log.info("on air: %s (FM %.1f), host %s, speech=%s", bible["name"], dial / 10, bible["host"]["name"], tts.name)

    source = rtc.AudioSource(TTS_SAMPLE_RATE, 1, queue_size_ms=400)
    track = rtc.LocalAudioTrack.create_audio_track("host", source)
    await ctx.room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    await ctx.room.local_participant.set_attributes({"role": "host", "host": bible["host"]["name"], "station": bible["name"]})

    show = Show(ctx.room, dial, bible, api, Brain(bible), Speaker(source, tts, bible["host"]["voice"]), stt)

    async def on_shutdown() -> None:
        show.close()

    ctx.add_shutdown_callback(on_shutdown)
    try:
        await show.run()
    finally:
        # Nobody is listening: close the room so the next listener gets a fresh dispatch.
        try:
            await ctx.delete_room()
        except Exception as e:  # room may already be gone
            log.debug("delete_room: %s", e)
        ctx.shutdown("show frozen")


if __name__ == "__main__":
    cli.run_app(server)
