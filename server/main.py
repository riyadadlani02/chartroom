"""CHARTROOM server: replay or live consultation in, gap events out."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .corti import Corti
from .gaps import GapEngine, load_rulepack

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SCRIPT = json.loads((ROOT / "demo" / "consultation.json").read_text())

app = FastAPI(title="CHARTROOM")


@app.get("/api/session")
async def session_info() -> dict:
    rules = load_rulepack()
    corti = Corti()
    try:
        return {
            "live": corti.live,
            "environment": corti.env,
            "workflow": rules["workflow"],
            "codes": len(rules["codes"]),
            "requirements": len(rules["requirements"]),
            "script": SCRIPT["title"],
            "patient": SCRIPT["patient"]["name"],
        }
    finally:
        await corti.aclose()


class Session:
    """One consultation. Owns the transcript, the engine and the client socket."""

    def __init__(self, sock: WebSocket) -> None:
        self.sock = sock
        self.corti = Corti()
        self.engine = GapEngine(self.corti)
        self.turns: list[dict] = []
        self.task: asyncio.Task | None = None
        self.audio: asyncio.Queue | None = None
        self._ticking = False
        self._dirty = False

    @property
    def transcript(self) -> str:
        return " ".join(t["text"] for t in self.turns)

    async def send(self, payload: dict) -> None:
        with contextlib.suppress(RuntimeError, WebSocketDisconnect):
            await self.sock.send_json(payload)

    async def add_turn(self, speaker: str, text: str, t: float | None = None) -> None:
        prev = self.transcript
        self.turns.append(
            {
                "speaker": speaker,
                "text": text,
                "t": t,
                "at": len(prev) + (1 if prev else 0),
            }
        )
        await self.send({"type": "turn", "turn": self.turns[-1]})
        await self.tick()

    async def tick(self) -> None:
        """Coalesce: one analysis in flight, one queued behind it."""
        if self._ticking:
            self._dirty = True
            return
        self._ticking = True
        try:
            while True:
                self._dirty = False
                state, events = await self.engine.tick(self.transcript)
                await self.send(
                    {
                        "type": "state",
                        "state": {
                            "codes": state.codes,
                            "gaps": state.gaps,
                            "facts": state.facts,
                            "atRisk": state.at_risk,
                            "captured": state.captured,
                            "live": state.live,
                        },
                        "events": events,
                    }
                )
                if not self._dirty:
                    return
        finally:
            self._ticking = False

    async def replay(self, speed: float) -> None:
        await self.send({"type": "started", "mode": "replay", "total": len(SCRIPT["turns"])})
        clock = 0.0
        for turn in SCRIPT["turns"]:
            await asyncio.sleep(max(0.0, (turn["t"] - clock) / speed))
            clock = turn["t"]
            await self.add_turn(turn["speaker"], turn["text"], turn["t"])
        await self.send({"type": "ended"})

    async def go_live(self) -> None:
        """Real microphone, real Corti stream."""
        if not self.corti.live:
            await self.send({"type": "error", "detail": "No Corti credentials configured."})
            return
        created = await self.corti.create_interaction(
            SCRIPT["patient"], SCRIPT["encounter"]
        )
        self.audio = asyncio.Queue()
        await self.send({"type": "started", "mode": "live", "interactionId": created["interactionId"]})

        async def on_message(frame: dict) -> None:
            if frame.get("type") == "transcript":
                for seg in frame.get("data", []):
                    if seg.get("final"):
                        speaker = "clinician" if seg.get("speakerId", 0) == 0 else "patient"
                        await self.add_turn(speaker, seg["transcript"], seg["time"]["start"])

        await self.corti.stream(created["websocketUrl"], self.audio, on_message)
        await self.send({"type": "ended"})

    async def stop(self) -> None:
        if self.audio:
            await self.audio.put(None)
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
            self.task = None

    async def reset(self) -> None:
        await self.stop()
        self.turns.clear()
        self.engine = GapEngine(self.corti)
        await self.send({"type": "reset"})


@app.websocket("/ws")
async def ws(sock: WebSocket) -> None:
    await sock.accept()
    session = Session(sock)
    try:
        while True:
            msg = await sock.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if (blob := msg.get("bytes")) is not None:
                if session.audio:
                    await session.audio.put(blob)
                continue
            cmd = json.loads(msg["text"])
            match cmd.get("cmd"):
                case "replay":
                    await session.reset()
                    session.task = asyncio.create_task(
                        session.replay(float(cmd.get("speed", 2)))
                    )
                case "live":
                    await session.reset()
                    session.task = asyncio.create_task(session.go_live())
                case "say":
                    # The clinician acts on a gap. This is the whole point.
                    await session.add_turn("clinician", cmd["text"])
                case "stop":
                    await session.stop()
                case "reset":
                    await session.reset()
    except WebSocketDisconnect:
        pass
    finally:
        await session.stop()
        await session.corti.aclose()


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))


if __name__ == "__main__":
    main()
