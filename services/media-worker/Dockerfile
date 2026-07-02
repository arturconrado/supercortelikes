FROM python:3.11-slim AS system

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MEDIA_WORKER_DATA_DIR=/data \
    HF_HOME=/data/models/huggingface \
    TORCH_HOME=/data/models/torch \
    XDG_CACHE_HOME=/data/models/cache \
    YOLO_CONFIG_DIR=/data/models

ARG DENO_VERSION=2.3.0
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg libglib2.0-0 libgl1 patchelf unzip \
    && case "$TARGETARCH" in \
      amd64) DENO_ARCH="x86_64" ;; \
      arm64) DENO_ARCH="aarch64" ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${DENO_ARCH}-unknown-linux-gnu.zip" -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && chmod +x /usr/local/bin/deno \
    && ffmpeg -version >/dev/null \
    && ffprobe -version >/dev/null \
    && deno --version >/dev/null \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-ai.txt ./

FROM system AS lite-dependencies
RUN pip install -r requirements.txt \
    && python -c "import yt_dlp; print('yt-dlp-import-ok')"

FROM system AS ai-dependencies
RUN pip install -r requirements-ai.txt \
    && find /usr/local/lib/python3.11/site-packages -name 'libctranslate2*.so*' -print -exec patchelf --clear-execstack {} \; \
    && python -c "import yt_dlp, whisperx, cv2, mediapipe, ultralytics; print('ai-imports-ok')"

FROM lite-dependencies AS lite
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-deps . \
    && useradd --create-home --uid 10001 worker \
    && mkdir -p /data/models /data/pipelines \
    && chown -R worker:worker /data
USER worker
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health/live', timeout=3)"
CMD ["uvicorn", "media_worker.app:app", "--host", "0.0.0.0", "--port", "8090"]

FROM ai-dependencies AS ai
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-deps . \
    && useradd --create-home --uid 10001 worker \
    && mkdir -p /data/models /data/pipelines \
    && chown -R worker:worker /data
USER worker
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health/live', timeout=3)"
CMD ["uvicorn", "media_worker.app:app", "--host", "0.0.0.0", "--port", "8090"]

FROM ai AS final
