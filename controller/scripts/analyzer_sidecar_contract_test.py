"""Dependency-free tests for the analyzer sidecar's path-handoff contract."""

import asyncio
import importlib.util
import sys
import tempfile
import types
from pathlib import Path


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


class FastAPI:
    def __init__(self, **_kwargs):
        pass

    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn


class BaseModel:
    def __init__(self, **values):
        for key, value in values.items():
            setattr(self, key, value)


fastapi = types.ModuleType("fastapi")
fastapi.FastAPI = FastAPI
fastapi.HTTPException = HTTPException
pydantic = types.ModuleType("pydantic")
pydantic.BaseModel = BaseModel
pydantic.Field = lambda **_kwargs: None
sys.modules["fastapi"] = fastapi
sys.modules["pydantic"] = pydantic

server_path = Path(__file__).parents[2] / "docker" / "analyzer" / "server.py"
spec = importlib.util.spec_from_file_location("subwave_analyzer_server", server_path)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

worker_calls = []


async def worker_request(payload):
    worker_calls.append(payload)
    return {"ok": True, "bpm": 120, "key": "8A", "intro_ms": 500, "confidence": 0.9}


server.analyzer_worker.request = worker_request


async def main():
    missing = "/definitely-not-mounted/subwave-track.audio"
    try:
        await server.analyze(server.AnalyzeRequest(path=missing))
    except HTTPException as err:
        assert err.status_code == 422, err.status_code
        assert err.detail == {
            "code": "path_unavailable",
            "message": f"analyzer cannot read controller path: {missing}",
        }, err.detail
    else:
        raise AssertionError("missing controller path reached the analyzer worker")
    assert worker_calls == [], worker_calls

    with tempfile.NamedTemporaryFile() as audio:
        result = await server.analyze(server.AnalyzeRequest(path=audio.name))
    assert result["ok"] is True, result
    assert worker_calls == [{"id": "1", "path": audio.name}], worker_calls


asyncio.run(main())
print("analyzer sidecar path contract: ok")
