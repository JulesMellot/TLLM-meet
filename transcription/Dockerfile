# TLLM*meet - serveur de transcription (Parakeet TDT 0.6B v3, ONNX int8, sur CPU)
# API compatible OpenAI : POST /v1/audio/transcriptions. Voir transcription/README.md.

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 asr
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Le modèle (environ 700 Mo en int8) est téléchargé une fois, à la construction de l'image :
# le conteneur démarre ensuite sans accès à Internet.
ARG ASR_MODEL=nemo-parakeet-tdt-0.6b-v3
ARG ASR_QUANTIZATION=int8
ENV ASR_MODEL=${ASR_MODEL} \
    ASR_QUANTIZATION=${ASR_QUANTIZATION} \
    HF_HOME=/models \
    HF_HUB_DISABLE_TELEMETRY=1
RUN mkdir -p /models && python -c "import os, onnx_asr; onnx_asr.load_model(os.environ['ASR_MODEL'], quantization=os.environ['ASR_QUANTIZATION'] or None)" \
    && chown -R asr:asr /models
ENV HF_HUB_OFFLINE=1

COPY server.py .

USER asr
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
