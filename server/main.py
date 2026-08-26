"""CHARTROOM proxy.

The gap engine runs in the browser (web/engine.js), so the demo needs no server
at all. This exists for one reason: the live path needs a Corti client secret,
and a client secret cannot live in a browser. Serve web/, forward four calls.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .corti import Corti

WEB = Path(__file__).resolve().parent.parent / "web"

JUDGE_SYSTEM = (
    "You are a clinical documentation integrity auditor. You are given a "
    "consultation transcript and a list of documentation requirements. For each "
    "requirement decide whether the transcript satisfies it. Be strict: a "
    "requirement is met only if the transcript itself contains the element, not "
    "if it is merely implied or clinically obvious. Answer with a JSON object "
    'of the form {"<id>": {"met": true|false, "quote": "<verbatim span from the '
    'transcript, or empty string>"}}. The quote must be copied character for '
    "character from the transcript. Output JSON only."
)

app = FastAPI(title="CHARTROOM")
corti = Corti()


@app.on_event("shutdown")
async def _shutdown() -> None:
    await corti.aclose()


@app.get("/api/session")
async def session() -> dict:
    return {"live": corti.live, "environment": corti.env}


@app.post("/api/coding")
async def coding(body: dict) -> dict:
    return await corti.predict_codes(body["text"], body["systems"])


@app.post("/api/facts")
async def facts(body: dict) -> dict:
    return await corti.extract_facts(body["text"])


@app.post("/api/judge")
async def judge(body: dict) -> dict:
    """One narrow question per requirement, answered against the transcript."""
    raw = await corti.chat([
        {"role": "system", "content": JUDGE_SYSTEM},
        {
            "role": "user",
            "content": f"TRANSCRIPT:\n{body['transcript']}\n\nREQUIREMENTS:\n"
            + json.dumps(body["asked"], indent=1),
        },
    ])
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        return json.loads(m.group(0)) if m else {}


@app.websocket("/api/stream")
async def stream(sock: WebSocket) -> None:
    """Browser audio in, Corti transcript frames out. The engine stays client-side."""
    await sock.accept()
    if not corti.live:
        await sock.close(code=1011, reason="No Corti credentials configured.")
        return

    script = json.loads((WEB / "demo" / "consultation.json").read_text())
    created = await corti.create_interaction(script["patient"], script["encounter"])
    audio: asyncio.Queue = asyncio.Queue()

    async def relay(frame: dict) -> None:
        with contextlib.suppress(RuntimeError, WebSocketDisconnect):
            await sock.send_json(frame)

    pump = asyncio.create_task(corti.stream(created["websocketUrl"], audio, relay))
    try:
        while True:
            msg = await sock.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if (blob := msg.get("bytes")) is not None:
                await audio.put(blob)
    except WebSocketDisconnect:
        pass
    finally:
        await audio.put(None)
        pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump


# Everything else is the static console — the same files a static host serves.
app.mount("/", StaticFiles(directory=WEB, html=True), name="web")


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))


if __name__ == "__main__":
    main()
