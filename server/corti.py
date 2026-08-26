"""Corti API client: OAuth, coding, facts, documents, chat, and the streaming WS.

Every method degrades to demo/fixtures.json when credentials are absent, so the
demo runs on a plane. `Corti.live` tells you which mode you are in.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

FIXTURES = Path(__file__).resolve().parent.parent / "demo" / "fixtures.json"


class Corti:
    def __init__(self) -> None:
        self.env = os.getenv("CORTI_ENVIRONMENT", "eu")
        self.tenant = os.getenv("CORTI_TENANT", "")
        self.client_id = os.getenv("CORTI_CLIENT_ID", "")
        self.client_secret = os.getenv("CORTI_CLIENT_SECRET", "")
        self.base = f"https://api.{self.env}.corti.app/v2"
        self.auth_url = (
            f"https://auth.{self.env}.corti.app/realms/{self.tenant}"
            "/protocol/openid-connect/token"
        )
        self._token = ""
        self._token_exp = 0.0
        self._http = httpx.AsyncClient(timeout=20.0)
        self._fixtures = json.loads(FIXTURES.read_text()) if FIXTURES.exists() else {}

    @property
    def live(self) -> bool:
        return bool(self.client_id and self.client_secret and self.tenant)

    async def aclose(self) -> None:
        await self._http.aclose()

    # --- auth -------------------------------------------------------------
    async def token(self) -> str:
        # Corti tokens live 300s; refresh at 60s of headroom.
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        r = await self._http.post(
            self.auth_url,
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "scope": "openid",
            },
        )
        r.raise_for_status()
        body = r.json()
        self._token = body["access_token"]
        self._token_exp = time.time() + float(body.get("expires_in", 300))
        return self._token

    async def _post(self, path: str, payload: dict) -> dict:
        r = await self._http.post(
            f"{self.base}{path}",
            json=payload,
            headers={
                "Authorization": f"Bearer {await self.token()}",
                "Tenant-Name": self.tenant,
            },
        )
        r.raise_for_status()
        return r.json()

    # --- the four APIs ----------------------------------------------------
    async def predict_codes(self, text: str, systems: list[str]) -> dict:
        """POST /tools/coding/ -> codes[] with evidences[] {text,start,end}."""
        if not self.live:
            return self._fixture_codes(text)
        return await self._post(
            "/tools/coding/",
            {"system": systems, "context": [{"type": "text", "text": text}]},
        )

    async def extract_facts(self, text: str, language: str = "en") -> dict:
        """POST /tools/extract-facts -> facts[] {group,value,text}."""
        if not self.live:
            return self._fixture_facts(text)
        return await self._post(
            "/tools/extract-facts",
            {"context": [{"type": "text", "text": text}], "outputLanguage": language},
        )

    async def create_interaction(self, patient: dict, encounter: dict) -> dict:
        """POST /interactions/ -> {interactionId, websocketUrl}."""
        if not self.live:
            return {"interactionId": "demo-interaction", "websocketUrl": ""}
        return await self._post(
            "/interactions/", {"patient": patient, "encounter": encounter}
        )

    async def generate_document(
        self, interaction_id: str, context: list[dict], template_key: str
    ) -> dict:
        """POST /interactions/{id}/documents/ -> the note we attach codes to."""
        if not self.live:
            return {"sections": [], "usageInfo": {"creditsConsumed": 0}}
        return await self._post(
            f"/interactions/{interaction_id}/documents/",
            {
                "context": context,
                "templateKey": template_key,
                "outputLanguage": "en",
            },
        )

    async def chat(self, messages: list[dict], schema_hint: str = "") -> str:
        """OpenAI-compatible chat. Corti Models by default; any base URL works.

        Returns "" when no judge is configured, which the caller reads as
        "fall back to the deterministic checker".
        """
        base = os.getenv("CHARTROOM_LLM_BASE") or (
            f"{self.base}/corti-models/chat/completions" if self.live else ""
        )
        if not base:
            return ""
        key = os.getenv("CHARTROOM_LLM_KEY") or (
            await self.token() if self.live else ""
        )
        model = os.getenv("CHARTROOM_LLM_MODEL", "corti-medium")
        headers = {"Authorization": f"Bearer {key}"}
        if self.live and not os.getenv("CHARTROOM_LLM_KEY"):
            headers["Tenant-Name"] = self.tenant
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0,
        }
        if schema_hint:
            payload["response_format"] = {"type": "json_object"}
        r = await self._http.post(base, json=payload, headers=headers)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


    # --- streaming --------------------------------------------------------
    async def stream(self, ws_url: str, audio: asyncio.Queue, on_message) -> None:
        """Relay browser audio into a Corti stream, handing every frame back.

        Runs until the audio queue yields None.
        """
        import websockets

        sep = "&" if "?" in ws_url else "?"
        async with websockets.connect(
            f"{ws_url}{sep}token={await self.token()}", max_size=None
        ) as sock:
            await sock.send(json.dumps({
                "type": "config",
                "configuration": {
                    "transcription": {"primaryLanguage": "en", "diarize": True},
                    "mode": {"type": "facts", "outputLocale": "en"},
                    "audioFormat": os.getenv("CHARTROOM_AUDIO_MIME", "audio/webm"),
                    "keyterms": {"terms": [{"term": t} for t in KEYTERMS]},
                },
            }))

            async def pump() -> None:
                while (chunk := await audio.get()) is not None:
                    await sock.send(chunk)
                await sock.send(json.dumps({"type": "end"}))

            pumping = asyncio.create_task(pump())
            try:
                async for raw in sock:
                    if isinstance(raw, bytes):
                        continue
                    frame = json.loads(raw)
                    await on_message(frame)
                    if frame.get("type") == "ENDED":
                        break
            finally:
                pumping.cancel()

    # --- offline fixtures -------------------------------------------------
    def _fixture_codes(self, text: str) -> dict:
        """Replay recorded Corti coding output, revealed as the transcript grows.

        A fixture code appears once its `afterCue` has been spoken, and its
        evidence offsets are re-anchored against the live transcript so the
        audit chain still points at real characters.
        """
        low = text.lower()
        codes = []
        for c in self._fixtures.get("codes", []):
            cue = c.get("afterCue", "").lower()
            if cue and cue not in low:
                continue
            out = {k: v for k, v in c.items() if k != "afterCue"}
            out["evidences"] = _anchor(c.get("evidences", []), text)
            codes.append(out)
        return {"codes": codes, "candidates": [], "usageInfo": {"creditsConsumed": 0}}

    def _fixture_facts(self, text: str) -> dict:
        low = text.lower()
        facts = [
            f
            for f in self._fixtures.get("facts", [])
            if f.get("text", "").lower()[:40] in low
        ]
        return {"facts": facts, "outputLanguage": "en", "usageInfo": {"creditsConsumed": 0}}


def _anchor(evidences: list[dict], text: str) -> list[dict]:
    """Re-point recorded evidence spans at the current transcript."""
    out = []
    for e in evidences:
        quote = e.get("text", "")
        start = text.lower().find(quote.lower())
        if start < 0:
            continue
        out.append(
            {"contextIndex": 0, "text": text[start : start + len(quote)],
             "start": start, "end": start + len(quote)}
        )
    return out

# Terms the coding rules hang on. Corti biases the acoustic model toward these.
KEYTERMS = [
    "metformin", "HbA1c", "eGFR", "albuminuria", "monofilament", "neuropathy",
    "nephropathy", "SGLT2", "empagliflozin", "glargine", "retinopathy",
    "paraesthesia", "varenicline", "microalbumin",
]
