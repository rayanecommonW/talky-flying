import os
from pathlib import Path

from dotenv import load_dotenv

# In the repo, secrets live in the root .env; in a container they come from the environment.
_here = Path(__file__).resolve()
if len(_here.parents) > 3:
    load_dotenv(_here.parents[3] / ".env")


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


GAME_URL = env("GAME_URL", "http://localhost:2567")
INTERNAL_TOKEN = env("INTERNAL_TOKEN", "dev-internal-token")

# LiveKit Agents reads these itself; set dev defaults so `uv run python -m radio.main dev` just works.
os.environ.setdefault("LIVEKIT_URL", "ws://localhost:7880")
os.environ.setdefault("LIVEKIT_API_KEY", "devkey")
os.environ.setdefault("LIVEKIT_API_SECRET", "secret")

ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY")
HOST_MODEL = env("HOST_MODEL", "claude-haiku-5-5")

ELEVENLABS_API_KEY = env("ELEVENLABS_API_KEY")
ELEVENLABS_TTS_MODEL = env("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5")
ELEVENLABS_STT_MODEL = env("ELEVENLABS_STT_MODEL", "scribe_v1")

# OpenAI-compatible local speech server (Speaches: Kokoro TTS + faster-whisper STT).
LOCAL_SPEECH_URL = env("LOCAL_SPEECH_URL", "http://localhost:8008/v1")
LOCAL_TTS_MODEL = env("LOCAL_TTS_MODEL", "speaches-ai/Kokoro-82M-v1.0-ONNX")
LOCAL_STT_MODEL = env("LOCAL_STT_MODEL", "Systran/faster-whisper-base.en")

# "elevenlabs" | "local" | "auto" (ElevenLabs when a key is present, local otherwise)
SPEECH_PROVIDER = env("SPEECH_PROVIDER", "auto")

# Leave the room after this long with no listeners (the show stays frozen in the DB).
IDLE_EXIT_S = float(env("IDLE_EXIT_S", "45"))
# Concurrent on-air stations one worker process pool will take.
MAX_SHOWS_PER_WORKER = int(env("MAX_SHOWS_PER_WORKER", "12"))
# Longest caller transmission we transcribe.
MAX_CALL_S = float(env("MAX_CALL_S", "30"))
