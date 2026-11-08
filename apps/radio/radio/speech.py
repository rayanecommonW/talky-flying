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
            if r.status_code in (400, 404, 422) and voice != DEFAULT_ELEVENLABS_VOICE:
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


def make_speech(http: httpx.AsyncClient) -> tuple[TTS, STT]:
    provider = config.SPEECH_PROVIDER
    if provider == "auto":
        provider = "elevenlabs" if config.ELEVENLABS_API_KEY else "local"
    if provider == "elevenlabs":
        if not config.ELEVENLABS_API_KEY:
            raise RuntimeError("SPEECH_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is not set")
        key = config.ELEVENLABS_API_KEY
        return ElevenLabsTTS(key, config.ELEVENLABS_TTS_MODEL, http), ElevenLabsSTT(key, config.ELEVENLABS_STT_MODEL, http)
    base = config.LOCAL_SPEECH_URL
    return LocalTTS(base, config.LOCAL_TTS_MODEL, http), LocalSTT(base, config.LOCAL_STT_MODEL, http)
