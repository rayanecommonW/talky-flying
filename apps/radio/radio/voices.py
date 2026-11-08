"""Provider-agnostic voice archetypes (from the station bible) -> concrete TTS voices."""

from .config import env

# ElevenLabs default voices (usable on every plan, including free; library voices need a paid plan).
# Override any of them with ELEVENLABS_VOICE_<ARCHETYPE>=<voice id>.
ELEVENLABS = {
    "gravel_male": "N2lVS1w4EtoT3dr4eOWO",  # Callum, husky
    "warm_male": "nPczCjzI2devNBz1zQrb",  # Brian, deep and resonant
    "young_male": "TX3LPaxmHKxFdv7VOQHJ",  # Liam, energetic
    "british_male": "onwK4e9ZLuTAKqWW03F9",  # Daniel, steady broadcaster
    "warm_female": "XrExE9yKIg1WjnnlVkGX",  # Matilda
    "smoky_female": "pFZP5JQG7iQjIQuC4Bku",  # Lily, velvety
    "bright_female": "cgSgspJ2msm6clMCkdW9",  # Jessica, bright
    "british_female": "Xb7hH8MSUJpSbSDYk0k2",  # Alice
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
