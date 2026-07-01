# syntax=docker/dockerfile:1.7
FROM node:22.17.0-bookworm-slim AS manifests
WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm install --global npm@11.12.1

FROM manifests AS node-build
RUN --mount=type=cache,target=/root/.npm npm ci
COPY apps ./apps
RUN npm run db:generate --workspace @clipbr/api \
    && npm run build --workspace @clipbr/api

FROM manifests AS node-production
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
    && node -e "require.resolve('ioredis', {paths:['/workspace/apps/api']}); require.resolve('bullmq', {paths:['/workspace/apps/api']})"

FROM python:3.11-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production \
    APP_ENV=release \
    MEDIA_WORKER_URL=http://127.0.0.1:8090 \
    MEDIA_WORKER_DATA_DIR=/data \
    HF_HOME=/data/models/huggingface \
    TORCH_HOME=/data/models/torch \
    XDG_CACHE_HOME=/data/models/cache \
    YOLO_CONFIG_DIR=/data/models \
    MEDIA_MAX_CONCURRENT_JOBS=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init ffmpeg libglib2.0-0 libgl1 ca-certificates openssl \
    && ffmpeg -version >/dev/null \
    && ffprobe -version >/dev/null \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/media-worker/requirements.txt services/media-worker/requirements-ai.txt ./
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements-ai.txt \
    && python -c "import whisperx,cv2,mediapipe,ultralytics,redis; print('bundle-ai-imports-ok')"

COPY services/media-worker/pyproject.toml ./
COPY services/media-worker/src ./src
RUN pip install --no-deps .

WORKDIR /workspace
COPY --from=manifests /usr/local/bin/node /usr/local/bin/node
COPY --from=node-production /workspace/node_modules ./node_modules
COPY --from=node-production /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=node-build /workspace/node_modules/.prisma ./node_modules/.prisma
COPY --from=node-build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=node-build /workspace/apps/api/dist ./apps/api/dist
COPY --from=node-build /workspace/apps/api/prisma ./apps/api/prisma
COPY --chmod=755 infra/render/worker-entrypoint.sh /usr/local/bin/worker-entrypoint

RUN useradd --create-home --uid 10001 worker \
    && mkdir -p /data/models /data/pipelines \
    && chown -R worker:worker /data

USER worker
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/worker-entrypoint"]
