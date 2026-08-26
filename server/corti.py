"""Corti API client. Exists only to hold the credentials the browser must not.

The gap engine lives in web/engine.js and runs in the browser. This module is
the thin server side of the live path: OAuth, and the four calls the engine
cannot make itself without leaking a client secret.
"""
from __future__ import annotations

import asyncio
import json
import os

import httpx

# Terms the coding rules hang on. Corti biases the acoustic model toward these.
KEYTERMS = [
    "metformin", "HbA1c", "eGFR", "albuminuria", "monofilament", "neuropathy",
    "nephropathy", "SGLT2", "empagliflozin", "glargine", "retinopathy",
    "paraesthesia", "varenicline", "microalbumin",
]


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

    @property
    def live(self) -> bool:
        return bool(self.client_id and self.client_secret and self.tenant)

    async def aclose(self) -> None:
        await self._http.aclose()

    # --- auth -------------------------------------------------------------
    async def token(self) -> str:
        # Corti tokens live 300s; refresh at 60s of headroom.
        loop = asyncio.get_running_loop()
        if self._token and loop.time() < self._token_exp - 60:
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
        self._token_exp = loop.time() + float(body.get("expires_in", 300))
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

    # --- the APIs ---------------------------------------------------------
    async def predict_codes(self, text: str, systems: list[str]) -> dict:
        """POST /tools/coding/ -> codes[] with evidences[] {text,start,end}."""
        return await self._post(
            "/tools/coding/",
            {"system": systems, "context": [{"type": "text", "text": text}]},
        )

    async def extract_facts(self, text: str, language: str = "en") -> dict:
        """POST /tools/extract-facts -> facts[] {group,value,text}."""
        return await self._post(
            "/tools/extract-facts",
            {"context": [{"type": "text", "text": text}], "outputLanguage": language},
        )

    async def create_interaction(self, patient: dict, encounter: dict) -> dict:
        """POST /interactions/ -> {interactionId, websocketUrl}."""
        return await self._post(
            "/interactions/", {"patient": patient, "encounter": encounter}
        )

    async def chat(self, messages: list[dict]) -> str:
        """OpenAI-compatible chat. Corti Models by default; any base URL works.

        The models path is not in Corti's public docs index, so it is a default
        rather than a certainty — CHARTROOM_LLM_BASE overrides it.
        """
        base = os.getenv("CHARTROOM_LLM_BASE") or f"{self.base}/corti-models/chat/completions"
        key = os.getenv("CHARTROOM_LLM_KEY") or await self.token()
        headers = {"Authorization": f"Bearer {key}"}
        if not os.getenv("CHARTROOM_LLM_KEY"):
            headers["Tenant-Name"] = self.tenant
        r = await self._http.post(
            base,
            json={
                "model": os.getenv("CHARTROOM_LLM_MODEL", "corti-medium"),
                "messages": messages,
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
            headers=headers,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    # --- streaming --------------------------------------------------------
    async def stream(self, ws_url: str, audio: asyncio.Queue, on_message) -> None:
        """Relay browser audio into a Corti stream, handing every frame back."""
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
