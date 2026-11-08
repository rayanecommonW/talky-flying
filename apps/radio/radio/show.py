"""One live radio show: monologue segments, caller turns, freeze when nobody listens."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from livekit import rtc

from . import config
from .brain import Brain
from .game_api import GameApi
from .speaker import Speaker, tone
from .speech import Speech

log = logging.getLogger("radio.show")

CALL_SAMPLE_RATE = 16_000
SUMMARIZE_EVERY = 4
# Backup in case the host agrees on air but forgets the control line.
ASKS_FOR_ESCORT = re.compile(r"\b(escort|backup|back up|assist|assistance|wingm[ae]n|send (me )?(some |a )?drones?)\b", re.IGNORECASE)
KEEP_RECENT = 24


def is_human(p: rtc.RemoteParticipant) -> bool:
    return not p.identity.startswith("agent-") and p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT


@dataclass
class Call:
    identity: str
    callsign: str
    started: float = field(default_factory=time.monotonic)
    pcm: bytearray = field(default_factory=bytearray)
    recorder: asyncio.Task | None = None
    ended: bool = False
    # Set once the tail of the recording is in.
    done: asyncio.Event = field(default_factory=asyncio.Event)


class Show:
    def __init__(self, room: rtc.Room, dial: int, bible: dict[str, Any], api: GameApi, brain: Brain, speaker: Speaker, stt: Speech):
        self.room, self.dial, self.bible = room, dial, bible
        self.api, self.brain, self.speaker, self.stt = api, brain, speaker, stt
        self.segment = 0
        self.summary = ""
        self.pending: deque[str] = deque()
        self.recent: list[str] = []
        self.resumed = False
        self.call: Call | None = None
        self.finished_calls: deque[Call] = deque()
        self.audio_tracks: dict[str, rtc.RemoteAudioTrack] = {}
        # Unmuted before we had their track (events can arrive in either order).
        self.keyed_up: set[str] = set()
        self.wake = asyncio.Event()
        self.closing = False
        self._last_save = 0.0
        self._bg: set[asyncio.Task] = set()
        self.host = bible["host"]["name"]

    # ---------- state ----------

    async def load(self) -> None:
        data = await self.api.show(self.dial)
        st = data.get("state")
        if st:
            self.segment = st.get("segment", 0)
            self.summary = st.get("summary", "")
            self.pending = deque(st.get("pendingLines", []))
            self.recent = st.get("recentLines", [])[-KEEP_RECENT:]
            self.resumed = True
            log.info("%s: resuming at segment %d with %d pending lines", self.bible["name"], self.segment, len(self.pending))
        else:
            log.info("%s: first broadcast", self.bible["name"])

    def snapshot(self) -> dict[str, Any]:
        return {
            "segment": self.segment,
            "summary": self.summary,
            "pendingLines": list(self.pending),
            "recentLines": self.recent[-KEEP_RECENT:],
        }

    async def save(self, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self._last_save > 2:
            self._last_save = now
            await self.api.save_show(self.dial, self.snapshot())

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    # ---------- room wiring ----------

    def listeners(self) -> int:
        return sum(1 for p in self.room.remote_participants.values() if is_human(p))

    def attach(self) -> None:
        r = self.room

        @r.on("participant_connected")
        def _joined(p: rtc.RemoteParticipant) -> None:
            if is_human(p):
                log.info("listener joined: %s (%d listening)", p.name or p.identity, self.listeners())
                self._prefer(p.attributes.get("speech"))
                self.wake.set()

        @r.on("participant_attributes_changed")
        def _attrs(changed: dict[str, str], p: rtc.Participant) -> None:
            if isinstance(p, rtc.RemoteParticipant) and is_human(p) and "speech" in changed:
                self._prefer(changed["speech"])

        @r.on("participant_disconnected")
        def _left(p: rtc.RemoteParticipant) -> None:
            self.audio_tracks.pop(p.identity, None)
            self.keyed_up.discard(p.identity)
            self._end_call(p.identity)
            if is_human(p) and self.listeners() == 0:
                log.info("last listener left; freezing the show")
                self.speaker.interrupt()
            self.wake.set()

        @r.on("track_subscribed")
        def _sub(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
            if track.kind == rtc.TrackKind.KIND_AUDIO and is_human(p):
                self.audio_tracks[p.identity] = track  # type: ignore[assignment]
                log.info("subscribed to %s (muted=%s)", p.name or p.identity, pub.muted)
                if not pub.muted or p.identity in self.keyed_up:
                    self._start_call(p)

        @r.on("track_unmuted")
        def _unmuted(p: rtc.Participant, pub: rtc.TrackPublication) -> None:
            if isinstance(p, rtc.RemoteParticipant) and is_human(p) and pub.kind == rtc.TrackKind.KIND_AUDIO:
                self.keyed_up.add(p.identity)
                self._start_call(p)

        @r.on("track_muted")
        def _muted(p: rtc.Participant, pub: rtc.TrackPublication) -> None:
            if pub.kind == rtc.TrackKind.KIND_AUDIO:
                self.keyed_up.discard(p.identity)
                self._end_call(p.identity)

        @r.on("track_unpublished")
        def _unpub(pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
            self.audio_tracks.pop(p.identity, None)
            self._end_call(p.identity)

        # Listeners who were already in the room before we attached: adopt their tracks now.
        for p in list(r.remote_participants.values()):
            if not is_human(p):
                continue
            self._prefer(p.attributes.get("speech"))
            for pub in p.track_publications.values():
                if pub.kind == rtc.TrackKind.KIND_AUDIO and pub.track is not None:
                    _sub(pub.track, pub, p)

    def _prefer(self, engine: str | None) -> None:
        """Latest listener to pick a speech engine wins; the switch lands on the next line."""
        if self.stt.prefer(engine):
            self._spawn(self.room.local_participant.set_attributes({"speech": self.stt.name}))

    # ---------- callers (push-to-talk gives exact turn boundaries, no VAD needed) ----------

    def _start_call(self, p: rtc.RemoteParticipant) -> None:
        track = self.audio_tracks.get(p.identity)
        if track is None or (self.call and not self.call.ended):
            return
        call = Call(identity=p.identity, callsign=p.name or p.identity)
        self.call = call
        log.info("caller on the air: %s", call.callsign)
        self.speaker.interrupt()  # half-duplex: the host stops the moment a caller keys up

        async def record() -> None:
            stream = rtc.AudioStream.from_track(track=track, sample_rate=CALL_SAMPLE_RATE, num_channels=1)
            try:
                async for ev in stream:
                    call.pcm.extend(ev.frame.data.tobytes())
                    if time.monotonic() - call.started > config.MAX_CALL_S:
                        self._end_call(call.identity)
                        break
            finally:
                await stream.aclose()

        call.recorder = asyncio.create_task(record())
        self.wake.set()

    def _end_call(self, identity: str) -> None:
        call = self.call
        if not call or call.ended or call.identity != identity:
            return
        call.ended = True
        self.call = None
        # Queue it right away so the show doesn't slip back into its script in the meantime.
        self.finished_calls.append(call)
        self.wake.set()

        async def finish() -> None:
            await asyncio.sleep(0.15)  # let the tail of the last word arrive
            if call.recorder:
                call.recorder.cancel()
            call.done.set()

        self._spawn(finish())

    async def handle_call(self, call: Call) -> None:
        await call.done.wait()
        secs = len(call.pcm) / 2 / CALL_SAMPLE_RATE
        text = ""
        if secs >= 0.4:
            try:
                text = await self.stt.transcribe(bytes(call.pcm), CALL_SAMPLE_RATE)
            except Exception as e:
                log.error("STT failed: %s", e)
        log.info("caller %s (%.1fs): %r", call.callsign, secs, text)
        self.recent.append(f"CALLER {call.callsign}: {text or '(static)'}")
        self._spawn(self.api.transcript(self.dial, call.callsign, text or "(static)"))
        self.pending.clear()  # the show reacts to the call instead of carrying on with the old script

        # A quick console blip right away so the caller knows the host heard them.
        await self.speaker.play_pcm(tone(1200, 70) + tone(900, 90))
        world = await self.api.world() if self.bible.get("worldFeed") else None
        sent: list[int] = []

        def escort(n: int) -> None:
            if not sent:
                sent.append(n)
                self._spawn(self._send_escorts(call, n))

        lines = self.brain.reply_to_caller(call.callsign, text, self.summary, self.recent, world, on_escort=escort)
        await self.speaker.speak(lines, on_start=self._on_air, on_done=self._aired)
        if not sent and ASKS_FOR_ESCORT.search(text):
            escort(1)
        await self.save(force=True)

    async def _send_escorts(self, call: Call, n: int) -> None:
        total = await self.api.escort(call.identity, max(1, min(5, n)))
        log.info("escorts for %s: asked %d, now %s", call.callsign, n, total)
        if total is not None:
            self.recent.append(f"(transmitter: {call.callsign} now has {total} escort drone(s) following, max 5)")

    # ---------- the show ----------

    def _on_air(self, line: str) -> None:
        log.info("[%s] %s", self.host, line)

    async def _aired(self, line: str) -> None:
        self.recent.append(line)
        self.recent = self.recent[-KEEP_RECENT * 2 :]
        self._spawn(self.api.transcript(self.dial, self.host, line))
        await self.save()

    async def _drain(self) -> AsyncIterator[str]:
        while self.pending and not self.call and not self.finished_calls and self.listeners() > 0:
            yield self.pending.popleft()

    async def _summarize(self) -> None:
        self.summary = await self.brain.summarize(self.summary, self.recent)
        self.recent = self.recent[-KEEP_RECENT:]

    async def _wait(self, timeout: float) -> None:
        try:
            await asyncio.wait_for(self.wake.wait(), timeout)
        except TimeoutError:
            pass
        self.wake.clear()

    async def run(self) -> None:
        self.attach()
        await self.load()
        idle_since: float | None = None
        while not self.closing:
            if self.finished_calls:
                await self.handle_call(self.finished_calls.popleft())
                continue
            if self.call:  # someone is talking: stay quiet and listen
                await self._wait(1)
                continue
            if self.listeners() == 0:
                if idle_since is None:
                    idle_since = time.monotonic()
                    await self.save(force=True)
                if time.monotonic() - idle_since > config.IDLE_EXIT_S:
                    log.info("no listeners for %.0fs; going off air", config.IDLE_EXIT_S)
                    break
                await self._wait(2)
                continue
            if idle_since is not None:
                idle_since = None
                self.resumed = True

            if not self.pending:
                world = await self.api.world() if self.bible.get("worldFeed") else None
                lines = await self.brain.next_segment(self.segment, self.resumed, self.summary, self.recent, world)
                self.pending.extend(lines)
                self.segment += 1
                self.resumed = False
                if self.segment % SUMMARIZE_EVERY == 0:
                    self._spawn(self._summarize())
                if self.call or self.finished_calls:
                    continue

            unplayed = await self.speaker.speak(self._drain(), on_start=self._on_air, on_done=self._aired)
            self.pending.extendleft(reversed(unplayed))
            await self.save()

        await self.save(force=True)

    def close(self) -> None:
        self.closing = True
        self.speaker.interrupt()
        self.wake.set()
