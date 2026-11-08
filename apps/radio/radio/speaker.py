"""Turns lines of text into audio on a LiveKit track, one line ahead, and can be cut off instantly."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable

import numpy as np
from livekit import rtc

from .speech import TTS, TTS_SAMPLE_RATE

log = logging.getLogger("radio.speaker")

FRAME_MS = 20
SAMPLES_PER_FRAME = TTS_SAMPLE_RATE * FRAME_MS // 1000


def tone(freq: float, ms: int, gain: float = 0.18, rate: int = TTS_SAMPLE_RATE) -> bytes:
    t = np.arange(int(rate * ms / 1000)) / rate
    env = np.minimum(1, np.minimum(t, t[::-1]) * 200)  # 5 ms fade in/out
    return (np.sin(2 * np.pi * freq * t) * env * gain * 32767).astype(np.int16).tobytes()


class Speaker:
    def __init__(self, source: rtc.AudioSource, tts: TTS, archetype: str):
        self.source, self.tts, self.archetype = source, tts, archetype
        self._task: asyncio.Task | None = None
        self._interrupted = False

    async def synth(self, text: str) -> bytes:
        out = bytearray()
        async for chunk in self.tts.stream(text, self.archetype):
            out.extend(chunk)
        if len(out) % 2:
            out.pop()
        return bytes(out)

    async def play_pcm(self, pcm: bytes) -> None:
        step = SAMPLES_PER_FRAME * 2
        for i in range(0, len(pcm), step):
            chunk = pcm[i : i + step]
            if len(chunk) < step:
                chunk += b"\x00" * (step - len(chunk))
            await self.source.capture_frame(rtc.AudioFrame(chunk, TTS_SAMPLE_RATE, 1, SAMPLES_PER_FRAME))
        await self.source.wait_for_playout()

    async def _run(
        self,
        lines: AsyncIterator[str],
        on_start: Callable[[str], Awaitable[None] | None] | None,
        on_done: Callable[[str], Awaitable[None] | None] | None,
        inflight: deque[str],
    ) -> None:
        """Producer synthesizes up to two lines ahead while the consumer plays."""
        q: asyncio.Queue[tuple[str, bytes] | None] = asyncio.Queue(maxsize=2)

        async def produce() -> None:
            try:
                async for line in lines:
                    inflight.append(line)
                    try:
                        pcm = await self.synth(line)
                    except Exception as e:  # one bad line must not kill the show
                        log.error("TTS failed for %r: %s", line[:60], e)
                        pcm = b""
                    await q.put((line, pcm))
            finally:
                await q.put(None)

        producer = asyncio.create_task(produce())
        try:
            while (item := await q.get()) is not None:
                line, pcm = item
                if on_start:
                    r = on_start(line)
                    if asyncio.iscoroutine(r):
                        await r
                if pcm:
                    await self.play_pcm(pcm)
                inflight.popleft()
                if on_done:
                    r = on_done(line)
                    if asyncio.iscoroutine(r):
                        await r
        finally:
            producer.cancel()

    async def speak(
        self,
        lines: AsyncIterator[str],
        on_start: Callable[[str], Awaitable[None] | None] | None = None,
        on_done: Callable[[str], Awaitable[None] | None] | None = None,
    ) -> list[str]:
        """Speak lines until exhausted or interrupted. Returns lines taken but never fully played."""
        inflight: deque[str] = deque()
        self._interrupted = False
        self._task = asyncio.create_task(self._run(lines, on_start, on_done, inflight))
        try:
            await self._task
        except asyncio.CancelledError:
            if not self._interrupted:
                raise
        finally:
            self._task = None
        return list(inflight)

    def interrupt(self) -> None:
        if self._task and not self._task.done():
            self._interrupted = True
            self._task.cancel()
        self.source.clear_queue()

    @property
    def busy(self) -> bool:
        return self._task is not None and not self._task.done()
