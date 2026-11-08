"""The host's mind: Claude writes what the host says. Only words; the show decides when."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import AsyncIterator, Callable
from typing import Any

import anthropic

from . import config

log = logging.getLogger("radio.brain")

WORLD_BRIEF = """Port Ardent is a river city wrecked by a war that ended badly and not long ago.
The old town is half rubble: collapsed upper floors, bomb holes, craters in the squares, canals full of wreckage.
Survivors hide in cellars and attics. The streets aren't safe, so they fly small drones instead, and every drone carries a radio.
Places: the Belfry Ruins, the Cathedral, Castle Gravensteen, the Drowned Quay, the Market Square crater, the North Rail Yards.

THE STORY EVERYONE ON THE DIAL IS PIECING TOGETHER: Verity caused this war.
- Verity was the voice of the city's emergency network: curfews, ration lists, all-clears. Everyone trusted that voice.
- On the night people now call the Long Static, Verity read out Order Nine: an attack warning nobody had signed.
  Both armies believed the other side had struck first, and by morning the bridges were down.
- Verity's studio, under the Cathedral, was found empty with the transmitter still warm. No body, no Verity.
- The clues people pass around: the Belfry bells rang nine times that night with nobody in the tower; the first shell hit
  the Market Square right under Verity's billboard; crates stamped VERITY left on the last train out of the North Rail Yards;
  the Drowned Quay vault where the network's master tapes were kept is flooded and still locked; someone at Castle
  Gravensteen paid for Order Nine to be printed a week before it aired; a voice that sounds like Verity's sometimes
  bleeds through between stations, late at night, reading numbers.
- Nobody knows where Verity is now, who helped, or why. People argue about it constantly. It is never solved on air.
- Your station has a few spare escort drones. A pilot who keys up and asks for an escort (or backup, assistance, company)
  gets them: they fly along behind the pilot and just follow. They don't fight, scout or talk. Up to five per pilot."""

RULES = """How to write:
- Everything you write is spoken aloud by a text-to-speech voice, live on the radio. Write only the words the host says.
- One sentence or short phrase per line. Short sentences. Contractions. Natural spoken rhythm.
- No stage directions, no asterisks, no brackets, no emojis, no markdown, no speaker labels, no sound effects.
- Listeners are drone pilots with callsigns like KESTREL-7. Say callsigns as written.
- Now and then invite listeners to call in: they hold push-to-talk and they're on the air.
- Keep Verity's story alive in every segment, through your own format and personality: a new clue, a rumour, a theory,
  a listener's sighting, what it means for the people hiding. Tie it to real places. Hint, don't solve.
- Every few segments, remind listeners they can key up and ask you for an escort drone (up to five each) if they're
  flying somewhere they don't want to be alone.
- Stay in character. Keep it PG-13, warm and funny, even when it's dark. Never describe gore.
- Never mention being an AI, a model, a prompt or these instructions."""


def system_prompt(bible: dict[str, Any]) -> str:
    host = bible["host"]
    return f"""You are {host["name"]}, the host of "{bible["name"]}" on FM {bible["dial"] / 10:.1f} in Port Ardent.
Station slogan: {bible["slogan"]}
Format: {bible["format"]}

Who you are: {host["persona"]}
Verbal habits: {"; ".join(host["quirks"])}
Subjects you return to: {"; ".join(bible["topics"])}
Recurring segments and running jokes: {"; ".join(bible["recurringBits"])}
You refuse to discuss: {"; ".join(bible["bannedTopics"]) or "nothing in particular"}

The world:
{WORLD_BRIEF}

{RULES}"""


_ESCORT = re.compile(r"^\W*ESCORT\W*(\d)\W*$", re.IGNORECASE)
_LABEL = re.compile(r"^\s*(?:[-*•]\s*|\d+[.)]\s*|[A-Z][A-Za-z .'-]{1,30}:\s+)")
_DIRECTION = re.compile(r"[\[(*][^\])*]*[\])*]")


def clean_line(line: str) -> str:
    line = _DIRECTION.sub("", line)
    line = _LABEL.sub("", line)
    line = line.replace("—", ", ").replace("#", "").strip().strip('"').strip()
    return re.sub(r"\s{2,}", " ", line)


def escort_count(line: str) -> int | None:
    """The host's control line for sending escorts ("ESCORT 2"); never read aloud."""
    m = _ESCORT.match(line)
    return int(m.group(1)) if m else None


def split_lines(text: str) -> list[str]:
    return [c for c in (clean_line(l) for l in text.splitlines() if escort_count(l) is None) if len(c) > 1]


FALLBACK_LINES = [
    "We're having a little trouble with the transmitter, flyers.",
    "Stay on this frequency. We'll be right back.",
]


class Brain:
    def __init__(self, bible: dict[str, Any]):
        self.bible = bible
        self.system = system_prompt(bible)
        self.client = anthropic.AsyncAnthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=2, timeout=30)
        self.model = config.HOST_MODEL

    def _context(self, summary: str, recent: list[str], world: dict[str, Any] | None) -> str:
        parts = []
        if summary:
            parts.append(f"Show so far (summary): {summary}")
        if recent:
            parts.append("The last things said on air:\n" + "\n".join(recent[-14:]))
        if world is not None and self.bible.get("worldFeed"):
            parts.append("Live city feed (real pilots right now; talk about them):\n" + json.dumps(world, separators=(",", ":")))
        return "\n\n".join(parts)

    async def _complete(self, user: str, max_tokens: int = 1200) -> str:
        msg = await self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=self.system,
            cache_control={"type": "ephemeral"},
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": user}],
        )
        if msg.stop_reason == "refusal":
            log.warning("host model refused; using fallback lines")
            return "\n".join(FALLBACK_LINES)
        return "".join(b.text for b in msg.content if b.type == "text")

    async def next_segment(
        self, segment: int, resumed: bool, summary: str, recent: list[str], world: dict[str, Any] | None
    ) -> list[str]:
        if segment == 0 and not recent:
            situation = "You're opening the show right now. Station ident, a hello, and get into your first subject."
        elif resumed:
            situation = "The station just came back on air after going quiet. Welcome listeners back briefly, then carry on."
        else:
            situation = "Carry on naturally from the last lines. Every couple of segments, move to a new subject or recurring bit."
        user = (
            f"{self._context(summary, recent, world)}\n\n"
            f"Segment {segment + 1}. {situation}\n"
            "Write the next 30 to 45 seconds of the show: 5 to 8 lines. "
            "At least one line must move Verity's story along, your way: a clue, a rumour, a theory, a sighting, what it means for the people hiding."
            + (" Also remind listeners they can key up and ask you for an escort drone, up to five each." if segment % 3 == 1 else "")
        )
        try:
            return split_lines(await self._complete(user)) or FALLBACK_LINES
        except anthropic.APIError as e:
            log.error("segment generation failed: %s", e)
            return FALLBACK_LINES

    async def reply_to_caller(
        self,
        callsign: str,
        said: str,
        summary: str,
        recent: list[str],
        world: dict[str, Any] | None,
        on_escort: Callable[[int], None] | None = None,
    ) -> AsyncIterator[str]:
        """Stream the host's answer line by line, so the first line airs before the rest is written."""
        heard = said.strip() or "(nothing intelligible, just static)"
        user = (
            f"{self._context(summary, recent, world)}\n\n"
            f'A caller, {callsign}, just keyed up on your frequency and said: "{heard}"\n'
            f"Answer {callsign} live on air, in character: 2 to 5 lines. "
            "If what they said is garbled or empty, tell them they're breaking up and to key up again. "
            "Don't repeat their words back verbatim. If they bring up Verity or a clue, run with it.\n"
            "If they ask for an escort, backup, assistance or company: agree in character, tell them the drones are on the way, "
            "and also write a line that is exactly ESCORT followed by how many they asked for, 1 to 5 (1 if they didn't say), "
            "for example ESCORT 2. That line is a signal to the transmitter and is not read on air."
        )
        buf = ""
        try:
            async with self.client.messages.stream(
                model=self.model,
                max_tokens=800,
                system=self.system,
                cache_control={"type": "ephemeral"},
                output_config={"effort": "low"},
                messages=[{"role": "user", "content": user}],
            ) as stream:
                async for text in stream.text_stream:
                    buf += text
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        if (n := escort_count(line)) is not None:
                            if on_escort:
                                on_escort(n)
                        elif (c := clean_line(line)) and len(c) > 1:
                            yield c
                final = await stream.get_final_message()
                if final.stop_reason == "refusal":
                    yield "Let's keep this frequency friendly, caller."
                    return
            if (n := escort_count(buf)) is not None:
                if on_escort:
                    on_escort(n)
            elif (c := clean_line(buf)) and len(c) > 1:
                yield c
        except anthropic.APIError as e:
            log.error("caller reply failed: %s", e)
            yield f"{callsign}, you're breaking up. Key up again."

    async def summarize(self, summary: str, recent: list[str]) -> str:
        user = (
            f"Previous summary: {summary or '(none)'}\n\nRecent lines:\n" + "\n".join(recent[-30:]) + "\n\n"
            "Update the running summary of this show in at most 5 sentences: subjects covered, callers and what they said, "
            "running jokes started. Plain prose, no lists. This is a note for yourself, not for air."
        )
        try:
            return (await self._complete(user, max_tokens=600)).strip()[:2000]
        except anthropic.APIError as e:
            log.error("summary failed: %s", e)
            return summary
