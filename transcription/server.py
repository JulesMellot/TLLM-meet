"""TLLM*meet - speech-to-text server.

A small OpenAI-compatible endpoint (POST /v1/audio/transcriptions) in front of an ONNX model run by
onnx-asr. Default: NVIDIA Parakeet TDT 0.6B v3 in int8 (25 European languages, French included),
fast enough on a CPU for the one or two people speaking at the same time in a meeting.

The TLLM*meet server sends one sentence at a time (a few seconds of WebM/Opus from one microphone);
ffmpeg turns it into 16 kHz mono samples for the model.
"""

import hmac
import os
import subprocess
import tempfile
import threading
import time

import numpy as np
import onnx_asr
import onnxruntime as rt
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

MODEL = os.environ.get("ASR_MODEL", "nemo-parakeet-tdt-0.6b-v3")
QUANTIZATION = os.environ.get("ASR_QUANTIZATION", "int8") or None
API_KEY = os.environ.get("API_KEY", "")
THREADS = int(os.environ.get("ASR_THREADS", "0") or 0)  # 0: onnxruntime decides
MAX_PARALLEL = max(1, int(os.environ.get("ASR_MAX_PARALLEL", "2") or 2))
MAX_BYTES = int(os.environ.get("ASR_MAX_BYTES", str(25 * 1024 * 1024)))
MAX_SECONDS = 120
SAMPLE_RATE = 16000


def load():
    options = rt.SessionOptions()
    if THREADS > 0:
        options.intra_op_num_threads = THREADS
    return onnx_asr.load_model(MODEL, quantization=QUANTIZATION, sess_options=options)


model = None if os.environ.get("ASR_SKIP_LOAD") == "1" else load()
slots = threading.BoundedSemaphore(MAX_PARALLEL)
app = FastAPI(title="TLLM*meet transcription", docs_url=None, redoc_url=None, openapi_url=None)


def decode(data: bytes) -> np.ndarray:
    """Any audio ffmpeg reads (WebM/Opus, MP4/AAC, Ogg, WAV) -> float32 mono 16 kHz."""
    # A file rather than a pipe: MP4 from Safari keeps its index at the end
    with tempfile.NamedTemporaryFile(suffix=".audio") as src:
        src.write(data)
        src.flush()
        proc = subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", src.name,
             "-t", str(MAX_SECONDS), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
            capture_output=True,
            timeout=60,
            check=False,
        )
    if proc.returncode != 0:
        raise HTTPException(400, detail={"message": "Audio illisible: " + proc.stderr.decode(errors="replace")[-300:]})
    return np.frombuffer(proc.stdout, dtype=np.float32)


def check_key(authorization: str | None):
    if not API_KEY:
        return
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given.encode(), API_KEY.encode()):
        raise HTTPException(401, detail={"message": "Invalid API key"})


@app.get("/health")
def health():
    return {"ok": model is not None, "model": MODEL, "quantization": QUANTIZATION}


@app.get("/v1/models")
def models(authorization: str | None = Header(default=None)):
    check_key(authorization)
    return {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "tllm-meet"}]}


@app.post("/v1/audio/transcriptions")
def transcriptions(
    file: UploadFile = File(...),
    model_name: str = Form(default="", alias="model"),
    language: str = Form(default=""),
    response_format: str = Form(default="json"),
    authorization: str | None = Header(default=None),
):
    check_key(authorization)
    data = file.file.read(MAX_BYTES + 1)
    if not data:
        raise HTTPException(400, detail={"message": "Empty audio"})
    if len(data) > MAX_BYTES:
        raise HTTPException(413, detail={"message": "Audio too large"})

    samples = decode(data)
    duration = len(samples) / SAMPLE_RATE
    text = ""
    started = time.perf_counter()
    if duration >= 0.2 and model is not None:
        with slots:  # a few at a time: more would only share the same CPU cores
            text = str(model.recognize(samples, sample_rate=SAMPLE_RATE)).strip()
    elapsed = time.perf_counter() - started

    if response_format == "text":
        return PlainTextResponse(text)
    body = {"text": text}
    if response_format == "verbose_json":
        # Parakeet v3 detects the language itself; the requested one is echoed back
        body.update({"task": "transcribe", "language": language or "auto", "duration": round(duration, 2),
                     "segments": [], "processing_time": round(elapsed, 3)})
    return body
