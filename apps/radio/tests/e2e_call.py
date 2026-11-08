"""End-to-end: listen to a live station, then call in and check the host answers.

Needs the full local stack running (livekit-server, game server, radio worker, speech server).
  uv run python tests/e2e_call.py 897 "Marta, is it true the pigeons in the belfry are spies?"
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
import wave
from pathlib import Path

import httpx
import numpy as np
from livekit import rtc

ROOT = Path(__file__).resolve().parents[3]
LOGS = ROOT / "logs"
SR = 48_000


def rms(pcm: bytes) -> float:
    a = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


def say_pcm(text: str) -> bytes:
    """Synthesize the caller's voice with macOS `say`, 48 kHz mono s16."""
    aiff = LOGS / "caller.aiff"
    subprocess.run(["say", "-v", "Daniel", "-o", str(aiff), text], check=True)
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(aiff), "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
        check=True, capture_output=True,
    )
    return out.stdout


def save_wav(path: Path, pcm: bytes, rate: int = SR) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


async def transcribe(pcm: bytes) -> str:
    path = LOGS / "tmp.wav"
    save_wav(path, pcm)
    async with httpx.AsyncClient(timeout=120) as http:
        r = await http.post(
            "http://localhost:8008/v1/audio/transcriptions",
            data={"model": "Systran/faster-whisper-base.en"},
            files={"file": ("a.wav", path.read_bytes(), "audio/wav")},
        )
        return r.json().get("text", "")


async def main(dial: int, question: str) -> int:
    LOGS.mkdir(exist_ok=True)
    helper = subprocess.Popen(
        ["npx", "tsx", "scripts/tune-token.ts", str(dial), "", "300"],
        cwd=ROOT / "apps/game", stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    grant = json.loads(helper.stdout.readline())
    print(f"tuned {grant['dial']/10:.1f}: {grant['station']['name']} (on air: {grant['station']['onAir']}) as {grant['callsign']}")

    room = rtc.Room()
    host_audio = bytearray()
    recording = {"on": True}
    host_track_ready = asyncio.Event()

    @room.on("track_subscribed")
    def _sub(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        print(f"subscribed to {p.identity} ({p.attributes.get('role', 'pilot')})")
        host_track_ready.set()

        async def pump() -> None:
            async for ev in rtc.AudioStream.from_track(track=track, sample_rate=SR, num_channels=1):
                if recording["on"]:
                    host_audio.extend(ev.frame.data.tobytes())

        asyncio.ensure_future(pump())

    await room.connect(grant["livekitUrl"], grant["token"])
    t0 = time.monotonic()
    await asyncio.wait_for(host_track_ready.wait(), 30)
    print(f"host track after {time.monotonic() - t0:.1f}s")

    # 1) the show is talking
    await asyncio.sleep(20)
    show_pcm = bytes(host_audio)
    save_wav(LOGS / "e2e-show.wav", show_pcm)
    level = rms(show_pcm)
    print(f"show audio: {len(show_pcm) / 2 / SR:.1f}s, rms {level:.0f}")
    show_text = await transcribe(show_pcm)
    print(f"show said: {show_text[:400]}")

    # 2) call in: take the floor, unmute, talk, mute, release
    source = rtc.AudioSource(SR, 1)
    mic = rtc.LocalAudioTrack.create_audio_track("mic", source)
    pub = await room.local_participant.publish_track(mic, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    mic.mute()
    await asyncio.sleep(0.5)
    caller_pcm = say_pcm(question)
    helper.stdin.write("ptt-down\n"); helper.stdin.flush()
    mic.unmute()
    await asyncio.sleep(0.3)
    cut = len(host_audio)
    step = SR // 100 * 2
    for i in range(0, len(caller_pcm), step):
        chunk = caller_pcm[i : i + step].ljust(step, b"\x00")
        await source.capture_frame(rtc.AudioFrame(chunk, SR, 1, step // 2))
    await source.wait_for_playout()
    await asyncio.sleep(0.4)
    during_call = bytes(host_audio[cut:])
    mic.mute()
    helper.stdin.write("ptt-up\n"); helper.stdin.flush()
    t_release = time.monotonic()
    print(f"called in ({len(caller_pcm) / 2 / SR:.1f}s); host level while caller talked: rms {rms(during_call):.0f}")

    # 3) the host answers
    mark = len(host_audio)
    first_voice = None
    while time.monotonic() - t_release < 25:
        await asyncio.sleep(0.1)
        tail = bytes(host_audio[-SR // 5 * 2 :])
        if first_voice is None and len(host_audio) > mark and rms(tail) > 300:
            first_voice = time.monotonic() - t_release
    reply_pcm = bytes(host_audio[mark:])
    save_wav(LOGS / "e2e-reply.wav", reply_pcm)
    reply_text = await transcribe(reply_pcm)
    print(f"host reply started after {first_voice and round(first_voice, 2)}s")
    print(f"host replied: {reply_text[:500]}")

    async with httpx.AsyncClient() as http:
        show = (await http.get(f"http://localhost:2567/internal/show/{dial}", headers={"authorization": "Bearer dev-internal-token"})).json()
    callers = [t for t in show["transcript"] if t["speaker"] == grant["callsign"]]
    print(f"transcript rows for caller: {callers[-1:] if callers else 'none'}")

    await room.disconnect()
    helper.stdin.close()
    helper.wait(timeout=10)

    ok = level > 300 and first_voice is not None and len(reply_text) > 10 and bool(callers) and rms(during_call) < level / 3
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    dial = int(sys.argv[1]) if len(sys.argv) > 1 else 897
    q = sys.argv[2] if len(sys.argv) > 2 else "Hello Belfry. Marta, is it true the pigeons in the tower are spies?"
    sys.exit(asyncio.run(main(dial, q)))
