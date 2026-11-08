"""Provider-agnostic voice archetypes (from the station bible) -> concrete TTS voices."""

from .config import env

# ElevenLabs premade voices. Override any of them with ELEVENLABS_VOICE_<ARCHETYPE>=<voice id>.
ELEVENLABS = {
    "gravel_male": "pNInz6obpgDQGcFmaJgB",  # Adam
    "warm_male": "TxGEqnHWrfWFTfGW9XZX",  # Josh
    "young_male": "yoZ06aMxZJJ28mfd3POQ",  # Sam
    "british_male": "JBFqnCBsd6RMkjVDRZzb",  # George
    "warm_female": "21m00Tcm4TlvDq8ikWAM",  # Rachel
    "smoky_female": "EXAVITQu4vr4xnSDxMaL",  # Bella / Sarah
    "bright_female": "MF3mGyEYCl7XYWbV9V6O",  # Elli
    "british_female": "ThT5KcBeYPX3keUQqHPh",  # Dorothy
}

# Kokoro voices served by Speaches.
KOKORO = {
    "gravel_male": "am_onyx",
    "warm_male": "am_michael",
    "young_male": "am_puck",
    "british_male": "bm_george",
    "warm_female": "af_heart",
    "smoky_female": "af_nicole",
    "bright_female": "af_bella",
    "british_female": "bf_emma",
}


def elevenlabs_voice(archetype: str) -> str:
    return env(f"ELEVENLABS_VOICE_{archetype.upper()}") or ELEVENLABS.get(archetype, ELEVENLABS["warm_male"])


def kokoro_voice(archetype: str) -> str:
    return KOKORO.get(archetype, "am_michael")
