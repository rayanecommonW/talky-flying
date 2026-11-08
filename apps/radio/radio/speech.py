"""TTS and STT behind one small interface, with ElevenLabs and a self-hosted fallback.

All audio is 16-bit little-endian mono PCM. TTS output is 24 kHz.
"""

from __future__ import annotations

import io
import logging
import wave
from collections.abc import AsyncIterator
from typing import Protocol

import httpx

from . import config
from .voices import elevenlabs_voice, kokoro_voice

log = logging.getLogger("radio.speech")

TTS_SAMPLE_RATE = 24_000
DEFAULT_ELEVENLABS_VOICE = "JBFqnCBsd6RMkjVDRZzb"  # George


class VoiceRejected(Exception):
    pass


class TTS(Protocol):
    name: str

    def stream(self, text: str, archetype: str) -> AsyncIterator[bytes]: ...


class STT(Protocol):
    name: str

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str: ...


def pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


class ElevenLabsTTS:
    name = "elevenlabs"

    def __init__(self, api_key: str, model: str, http: httpx.AsyncClient):
        self.api_key, self.model, self.http = api_key, model, http

    async def stream(self, text: str, archetype: str) -> AsyncIterator[bytes]:
        voice = elevenlabs_voice(archetype)
        try:
            async for chunk in self._stream(text, voice):
                yield chunk
        except VoiceRejected:
            # Premade voice ids change over time; never let a bad id take a station off air.
            log.warning("ElevenLabs rejected voice %s for %s; falling back to %s", voice, archetype, DEFAULT_ELEVENLABS_VOICE)
            async for chunk in self._stream(text, DEFAULT_ELEVENLABS_VOICE):
                yield chunk

    async def _stream(self, text: str, voice: str) -> AsyncIterator[bytes]:
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream"
        async with self.http.stream(
            "POST",
            url,
            params={"output_format": "pcm_24000"},
            headers={"xi-api-key": self.api_key},
            json={
                "text": text,
                "model_id": self.model,
                "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.35},
            },
        ) as r:
            if r.status_code in (400, 402, 404, 422) and voice != DEFAULT_ELEVENLABS_VOICE:
                raise VoiceRejected(voice)
            if r.status_code != 200:
                body = (await r.aread())[:300]
                raise RuntimeError(f"ElevenLabs TTS {r.status_code}: {body!r}")
            async for chunk in r.aiter_bytes():
                yield chunk


class ElevenLabsSTT:
    name = "elevenlabs"

    def __init__(self, api_key: str, model: str, http: httpx.AsyncClient):
        self.api_key, self.model, self.http = api_key, model, http

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        r = await self.http.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            headers={"xi-api-key": self.api_key},
            data={"model_id": self.model},
            files={"file": ("call.wav", pcm_to_wav(pcm, sample_rate), "audio/wav")},
        )
        r.raise_for_status()
        return str(r.json().get("text", "")).strip()


class LocalTTS:
    """OpenAI-compatible /audio/speech (Speaches + Kokoro)."""

    name = "local"

    def __init__(self, base_url: str, model: str, http: httpx.AsyncClient):
        self.base_url, self.model, self.http = base_url.rstrip("/"), model, http

    async def stream(self, text: str, archetype: str) -> AsyncIterator[bytes]:
        async with self.http.stream(
            "POST",
            f"{self.base_url}/audio/speech",
            json={"model": self.model, "voice": kokoro_voice(archetype), "input": text, "response_format": "pcm"},
        ) as r:
            if r.status_code != 200:
                raise RuntimeError(f"local TTS {r.status_code}: {(await r.aread())[:300]!r}")
            async for chunk in r.aiter_bytes():
                yield chunk


class LocalSTT:
    name = "local"

    def __init__(self, base_url: str, model: str, http: httpx.AsyncClient):
        self.base_url, self.model, self.http = base_url.rstrip("/"), model, http

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        r = await self.http.post(
            f"{self.base_url}/audio/transcriptions",
            data={"model": self.model},
            files={"file": ("call.wav", pcm_to_wav(pcm, sample_rate), "audio/wav")},
        )
        r.raise_for_status()
        return str(r.json().get("text", "")).strip()


class Speech:
    """Both speech engines behind the TTS and STT interfaces, switchable while a show runs.

    Listeners choose an engine in their settings (a LiveKit participant attribute); the show follows
    the latest listener to ask. If ElevenLabs fails before producing audio (bad key, out of credit),
    that line falls back to the local engine so the station never goes silent.
    """

    def __init__(self, http: httpx.AsyncClient, default: str | None = None):
        base = config.LOCAL_SPEECH_URL
        self.engines: dict[str, tuple[TTS, STT]] = {
            "local": (LocalTTS(base, config.LOCAL_TTS_MODEL, http), LocalSTT(base, config.LOCAL_STT_MODEL, http)),
        }
        if config.ELEVENLABS_API_KEY:
            key = config.ELEVENLABS_API_KEY
            self.engines["elevenlabs"] = (
                ElevenLabsTTS(key, config.ELEVENLABS_TTS_MODEL, http),
                ElevenLabsSTT(key, config.ELEVENLABS_STT_MODEL, http),
            )
        want = default or config.SPEECH_PROVIDER
        if want == "auto":
            want = "elevenlabs" if "elevenlabs" in self.engines else "local"
        self.name = want if want in self.engines else "local"

    def prefer(self, name: str | None) -> bool:
        """Switch engine. Returns True if it changed."""
        if not name or name == self.name:
            return False
        if name not in self.engines:
            log.warning("speech engine %r requested but not available (no key?); staying on %s", name, self.name)
            return False
        log.info("speech engine: %s -> %s", self.name, name)
        self.name = name
        return True

    async def stream(self, text: str, archetype: str) -> AsyncIterator[bytes]:
        tts = self.engines[self.name][0]
        produced = False
        try:
            async for chunk in tts.stream(text, archetype):
                produced = True
                yield chunk
        except Exception as e:
            if produced or self.name == "local":
                raise
            log.error("%s TTS failed (%s); speaking this line with the local engine", self.name, e)
            async for chunk in self.engines["local"][0].stream(text, archetype):
                yield chunk

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        try:
            return await self.engines[self.name][1].transcribe(pcm, sample_rate)
        except Exception as e:
            if self.name == "local":
                raise
            log.error("%s STT failed (%s); using the local engine", self.name, e)
            return await self.engines["local"][1].transcribe(pcm, sample_rate)
