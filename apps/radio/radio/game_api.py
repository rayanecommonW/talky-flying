from __future__ import annotations

import logging
from typing import Any

import httpx

from . import config

log = logging.getLogger("radio.game")


class GameApi:
    """The game server owns all durable state; the agent reads and writes it over internal HTTP."""

    def __init__(self, http: httpx.AsyncClient):
        self.http = http
        self.base = config.GAME_URL.rstrip("/")
        self.headers = {"authorization": f"Bearer {config.INTERNAL_TOKEN}"}

    async def station(self, dial: int) -> dict[str, Any]:
        r = await self.http.get(f"{self.base}/internal/stations/{dial}", headers=self.headers, timeout=60)
        r.raise_for_status()
        return r.json()

    async def show(self, dial: int) -> dict[str, Any]:
        r = await self.http.get(f"{self.base}/internal/show/{dial}", headers=self.headers)
        r.raise_for_status()
        return r.json()

    async def save_show(self, dial: int, state: dict[str, Any]) -> None:
        try:
            r = await self.http.put(f"{self.base}/internal/show/{dial}", headers=self.headers, json=state)
            r.raise_for_status()
        except httpx.HTTPError as e:
            log.warning("could not save show state: %s", e)

    async def transcript(self, dial: int, speaker: str, text: str) -> None:
        try:
            await self.http.post(f"{self.base}/internal/transcript/{dial}", headers=self.headers, json={"speaker": speaker, "text": text})
        except httpx.HTTPError as e:
            log.warning("could not save transcript: %s", e)

    async def escort(self, identity: str, count: int) -> int | None:
        """Send escort drones to follow a pilot. Returns how many follow them now."""
        try:
            r = await self.http.post(f"{self.base}/internal/escort", headers=self.headers, json={"identity": identity, "count": count}, timeout=5)
            r.raise_for_status()
            return r.json().get("total")
        except httpx.HTTPError as e:
            log.warning("could not send escorts: %s", e)
            return None

    async def world(self) -> dict[str, Any] | None:
        try:
            r = await self.http.get(f"{self.base}/internal/world", headers=self.headers, timeout=5)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError:
            return None
