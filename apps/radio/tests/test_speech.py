"""ElevenLabs adapters against a mocked HTTP transport (no key needed)."""

import httpx

from radio.speech import DEFAULT_ELEVENLABS_VOICE, ElevenLabsSTT, ElevenLabsTTS, pcm_to_wav
from radio.voices import elevenlabs_voice


def transport(seen: list[str]) -> httpx.MockTransport:
    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.path)
        assert req.headers["xi-api-key"] == "k"
        if req.url.path.startswith("/v1/text-to-speech/"):
            assert req.url.params["output_format"] == "pcm_24000"
            if DEFAULT_ELEVENLABS_VOICE not in req.url.path:
                return httpx.Response(404, json={"detail": "voice_not_found"})
            return httpx.Response(200, content=b"\x01\x00" * 480)
        if req.url.path == "/v1/speech-to-text":
            assert b"scribe_v1" in req.content and b"RIFF" in req.content
            return httpx.Response(200, json={"text": " Caller here. "})
        return httpx.Response(500)

    return httpx.MockTransport(handler)


async def test_tts_falls_back_to_default_voice_when_rejected():
    seen: list[str] = []
    async with httpx.AsyncClient(transport=transport(seen)) as http:
        tts = ElevenLabsTTS("k", "eleven_flash_v2_5", http)
        audio = b"".join([c async for c in tts.stream("Hello flyers.", "warm_female")])
    assert len(audio) == 960
    assert seen[0].endswith(f"/{elevenlabs_voice('warm_female')}/stream")
    assert seen[1].endswith(f"/{DEFAULT_ELEVENLABS_VOICE}/stream")


async def test_stt_sends_wav_and_strips_text():
    seen: list[str] = []
    async with httpx.AsyncClient(transport=transport(seen)) as http:
        stt = ElevenLabsSTT("k", "scribe_v1", http)
        assert await stt.transcribe(b"\x00\x00" * 1600, 16_000) == "Caller here."


def test_wav_header():
    wav = pcm_to_wav(b"\x00\x00" * 10, 16_000)
    assert wav[:4] == b"RIFF" and len(wav) == 44 + 20


async def test_speech_switches_engines_and_falls_back_to_local(monkeypatch):
    from radio import config
    from radio.speech import Speech

    monkeypatch.setattr(config, "ELEVENLABS_API_KEY", "k")
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.host)
        if req.url.host == "api.elevenlabs.io":
            return httpx.Response(401, json={"detail": "quota_exceeded"})
        return httpx.Response(200, content=b"\x02\x00" * 240)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        sp = Speech(http, default="local")
        assert sp.name == "local"
        assert not sp.prefer("nonsense")
        assert sp.prefer("elevenlabs") and sp.name == "elevenlabs"
        audio = b"".join([c async for c in sp.stream("Hello.", "warm_female")])
    # ElevenLabs refused, the line still went out on the local engine
    assert audio == b"\x02\x00" * 240
    assert calls == ["api.elevenlabs.io", "localhost"]


async def test_speech_without_key_stays_local(monkeypatch):
    from radio import config
    from radio.speech import Speech

    monkeypatch.setattr(config, "ELEVENLABS_API_KEY", None)
    async with httpx.AsyncClient() as http:
        sp = Speech(http, default="elevenlabs")
        assert sp.name == "local"
        assert not sp.prefer("elevenlabs")
