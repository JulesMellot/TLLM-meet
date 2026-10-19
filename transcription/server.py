"""TLLM*meet - speech-to-text server.

A small OpenAI-compatible endpoint (POST /v1/audio/transcriptions) in front of an ONNX model run by
onnx-asr. Default: NVIDIA Parakeet TDT 0.6B v3 in int8 (25 European languages, French included),
fast enough on a CPU for the one or two people speaking at the same time in a meeting.

The model only lives while it is needed. This process stays small (the web server, ffmpeg calls);
the model runs in a child process started on the first sentence, or by POST /v1/warmup when a
meeting starts its transcription, and stopped after ASR_IDLE_SECONDS without work: its memory goes
back to the system.

The TLLM*meet server sends one sentence at a time (a few seconds of WebM/Opus from one microphone);
ffmpeg turns it into 16 kHz mono samples for the model.
"""

import hmac
import logging
import multiprocessing as mp
import os
import subprocess
import tempfile
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

MODEL = os.environ.get("ASR_MODEL", "nemo-parakeet-tdt-0.6b-v3")
QUANTIZATION = os.environ.get("ASR_QUANTIZATION", "int8") or None
API_KEY = os.environ.get("API_KEY", "")
THREADS = int(os.environ.get("ASR_THREADS", "0") or 0)  # 0: onnxruntime decides
IDLE_SECONDS = max(10, int(os.environ.get("ASR_IDLE_SECONDS", "300") or 300))
MODEL_DIR = os.environ.get("HF_HOME", "/models")
# Canary and Whisper can be told the language; Parakeet detects it on its own
FORCE_LANGUAGE = any(name in MODEL.lower() for name in ("canary", "whisper"))
LOAD_TIMEOUT = 300
# A sentence takes a few seconds; past this the model process is stuck: it is killed and started again
RECOGNIZE_TIMEOUT = max(30, int(os.environ.get("ASR_RECOGNIZE_TIMEOUT", "120") or 120))
MAX_BYTES = int(os.environ.get("ASR_MAX_BYTES", str(25 * 1024 * 1024)))
MAX_SECONDS = 120
SAMPLE_RATE = 16000

log = logging.getLogger("uvicorn.error")


def drop_file_cache(root=MODEL_DIR):
    """Evict the model files from the page cache: the kernel charges it to this container's memory."""
    for folder, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(folder, name)
            if os.path.islink(path):
                continue
            try:
                fd = os.open(path, os.O_RDONLY)
            except OSError:
                continue
            try:
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            except OSError:
                pass
            finally:
                os.close(fd)


def container_memory():
    """Memory charged to this container (cgroup v2), in MB: total, process memory, file cache."""
    try:
        with open("/sys/fs/cgroup/memory.current") as f:
            total = int(f.read()) // 1048576
        stat = {}
        with open("/sys/fs/cgroup/memory.stat") as f:
            for line in f:
                key, value = line.split()
                stat[key] = int(value) // 1048576
        return {"total_mb": total, "process_mb": stat.get("anon"), "cache_mb": stat.get("file")}
    except (OSError, ValueError):
        return None


def worker_main(conn, model_name, quantization, threads):
    """Child process: load the model, then recognise float32 samples until told to stop."""
    try:
        import numpy as np
        import onnx_asr
        import onnxruntime as rt

        options = rt.SessionOptions()
        if threads > 0:
            options.intra_op_num_threads = threads
        model = onnx_asr.load_model(model_name, quantization=quantization, sess_options=options)
        conn.send(("ready", None))
    except Exception as err:  # noqa: BLE001 - reported to the parent
        conn.send(("error", f"{type(err).__name__}: {err}"))
        return
    while True:
        try:
            pcm = conn.recv()
        except EOFError:
            return
        if pcm is None:
            return
        pcm, language = pcm
        try:
            samples = np.frombuffer(pcm, dtype=np.float32)
            options = {"language": language} if language else {}
            conn.send(("ok", str(model.recognize(samples, sample_rate=SAMPLE_RATE, **options)).strip()))
        except Exception as err:  # noqa: BLE001
            conn.send(("error", f"{type(err).__name__}: {err}"))


class Engine:
    """The model process: started when needed, stopped when idle. One sentence at a time."""

    def __init__(self, target=worker_main):
        self.target = target
        self.ctx = mp.get_context("spawn")
        self.lock = threading.Lock()  # one sentence at a time, and start/stop
        self.proc = None
        self.conn = None
        self.last = 0.0
        self.loading = False

    @property
    def state(self):
        if self.loading:
            return "loading"
        return "ready" if self.proc is not None and self.proc.is_alive() else "stopped"

    def _start(self):
        if self.proc is not None and self.proc.is_alive():
            return
        self._stop()
        self.loading = True
        started = time.monotonic()
        try:
            parent, child = self.ctx.Pipe()
            proc = self.ctx.Process(target=self.target, args=(child, MODEL, QUANTIZATION, THREADS), daemon=True)
            proc.start()
            child.close()
            try:
                if not parent.poll(LOAD_TIMEOUT):
                    raise RuntimeError("model load timed out")
                try:
                    status, detail = parent.recv()
                except EOFError as err:
                    proc.join(5)
                    raise RuntimeError(f"model process exited while loading (code {proc.exitcode})") from err
                if status != "ready":
                    raise RuntimeError(detail)
            except BaseException:
                parent.close()
                if proc.is_alive():
                    proc.kill()
                proc.join(5)
                raise
            self.proc, self.conn = proc, parent
            self.last = time.monotonic()
            log.info("Model %s loaded in %.1f s, stopped after %d s without a sentence. Container memory: %s",
                     MODEL, time.monotonic() - started, IDLE_SECONDS, container_memory())
        finally:
            self.loading = False

    def _stop(self):
        proc, conn = self.proc, self.conn
        self.proc = self.conn = None
        if conn is not None:
            try:
                conn.send(None)
            except (OSError, ValueError):
                pass
        if proc is not None:
            proc.join(5)
            if proc.is_alive():
                proc.kill()
                proc.join(5)
        if conn is not None:
            conn.close()

    def _kill(self):
        proc, conn = self.proc, self.conn
        self.proc = self.conn = None
        if proc is not None:
            proc.kill()
            proc.join(5)
        if conn is not None:
            conn.close()
        log.error("Model process stopped: no answer after %d s (ASR_RECOGNIZE_TIMEOUT)", RECOGNIZE_TIMEOUT)

    def recognize(self, pcm: bytes, language: str = "") -> str:
        with self.lock:
            self._start()
            try:
                self.conn.send((pcm, language if FORCE_LANGUAGE else ""))
                if not self.conn.poll(RECOGNIZE_TIMEOUT):
                    # Stuck: without this, the lock stays held and no sentence is ever recognised again
                    self._kill()
                    raise RuntimeError("model process did not answer")
                status, detail = self.conn.recv()
            except (EOFError, OSError) as err:
                self._stop()  # the model process died: started again on the next sentence
                raise RuntimeError("model process stopped") from err
            self.last = time.monotonic()
            if status != "ok":
                raise RuntimeError(detail)
            return detail

    def warm(self):
        """Load the model in the background (a meeting starts its transcription)."""
        self.last = time.monotonic()
        if self.state != "stopped" or self.lock.locked():
            return

        def load():
            with self.lock:
                try:
                    self._start()
                except Exception as err:  # noqa: BLE001
                    log.error("Model load failed: %s", err)

        threading.Thread(target=load, daemon=True).start()

    def reap(self, now=None):
        """Stop the model process after IDLE_SECONDS without a sentence."""
        now = time.monotonic() if now is None else now
        if self.proc is None or now - self.last < IDLE_SECONDS:
            return False
        if not self.lock.acquire(blocking=False):
            return False  # busy
        try:
            if self.proc is None or now - self.last < IDLE_SECONDS:
                return False
            self._stop()
            drop_file_cache()
            log.info("Model stopped after %d s without work. Container memory: %s", IDLE_SECONDS, container_memory())
            return True
        finally:
            self.lock.release()


engine = Engine()


def reaper():
    while True:
        time.sleep(15)
        try:
            engine.reap()
        except Exception as err:  # noqa: BLE001
            log.error("Reaper: %s", err)


@asynccontextmanager
async def lifespan(_app):
    log.info("Model %s (%s) loaded on demand, stopped after %d s without a sentence (ASR_IDLE_SECONDS)",
             MODEL, QUANTIZATION or "full", IDLE_SECONDS)
    threading.Thread(target=reaper, daemon=True).start()
    yield
    with engine.lock:
        engine._stop()


app = FastAPI(title="TLLM*meet transcription", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def decode(data: bytes) -> bytes:
    """Any audio ffmpeg reads (WebM/Opus, MP4/AAC, Ogg, WAV) -> float32 mono 16 kHz samples."""
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
    return proc.stdout


def check_key(authorization: str | None):
    if not API_KEY:
        return
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given.encode(), API_KEY.encode()):
        raise HTTPException(401, detail={"message": "Invalid API key"})


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL,
        "quantization": QUANTIZATION,
        "state": engine.state,
        "idle_seconds": IDLE_SECONDS,
        "memory": container_memory(),
    }


@app.get("/v1/models")
def models(authorization: str | None = Header(default=None)):
    check_key(authorization)
    return {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "tllm-meet"}]}


@app.post("/v1/warmup")
def warmup(authorization: str | None = Header(default=None)):
    check_key(authorization)
    engine.warm()
    return {"state": engine.state}


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

    pcm = decode(data)
    duration = len(pcm) / 4 / SAMPLE_RATE
    text = ""
    started = time.perf_counter()
    if duration >= 0.2:
        try:
            text = engine.recognize(pcm, language.split("-")[0].lower() if language else "")
        except RuntimeError as err:
            raise HTTPException(503, detail={"message": f"Transcription indisponible: {err}"}) from err
    elapsed = time.perf_counter() - started

    if response_format == "text":
        return PlainTextResponse(text)
    body = {"text": text}
    if response_format == "verbose_json":
        # Parakeet v3 detects the language itself; the requested one is echoed back
        body.update({"task": "transcribe", "language": language or "auto", "duration": round(duration, 2),
                     "segments": [], "processing_time": round(elapsed, 3)})
    return body
