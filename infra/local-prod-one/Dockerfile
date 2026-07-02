# syntax=docker/dockerfile:1.7

FROM node:22.17.0-bookworm-slim AS node-manifests
WORKDIR /workspace
ARG NEXT_PUBLIC_API_URL=http://localhost:3331
ARG NEXT_PUBLIC_TERMS_VERSION=terms-2026-06
ARG NEXT_PUBLIC_PRIVACY_VERSION=privacy-2026-06
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_TERMS_VERSION=$NEXT_PUBLIC_TERMS_VERSION \
    NEXT_PUBLIC_PRIVACY_VERSION=$NEXT_PUBLIC_PRIVACY_VERSION \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm install --global npm@11.12.1

FROM node-manifests AS node-build
RUN --mount=type=cache,target=/root/.npm npm ci
COPY apps ./apps
RUN npm run db:generate --workspace @clipbr/api \
    && npm run build --workspace @clipbr/api \
    && npm run build --workspace @clipbr/web

FROM node-manifests AS node-production
RUN --mount=type=cache,target=/root/.npm test -s /workspace/package-lock.json \
    && npm ci --omit=dev \
    && node -e "require.resolve('ioredis', { paths: ['/workspace/apps/api'] }); require.resolve('bullmq', { paths: ['/workspace/apps/api'] }); require('@prisma/client')"

FROM python:3.11-slim-bookworm AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production \
    APP_ENV=production \
    PORT=3001 \
    WEB_PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    MEDIA_WORKER_URL=http://127.0.0.1:8090 \
    MEDIA_WORKER_DATA_DIR=/data/pipelines \
    HF_HOME=/data/models/huggingface \
    TORCH_HOME=/data/models/torch \
    TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1 \
    XDG_CACHE_HOME=/data/models/cache \
    MPLCONFIGDIR=/data/models/matplotlib \
    YOLO_CONFIG_DIR=/data/models \
    MEDIA_MAX_CONCURRENT_JOBS=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      dumb-init \
      ffmpeg \
      gosu \
      jq \
      libglib2.0-0 \
      libgl1 \
      openssl \
      postgresql \
      postgresql-client \
      procps \
      redis-server \
    && ffmpeg -version >/dev/null \
    && ffprobe -version >/dev/null \
    && rm -rf /var/lib/apt/lists/*

COPY --from=quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z /usr/bin/minio /usr/local/bin/minio
COPY --from=quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z /usr/bin/mc /usr/local/bin/mc

WORKDIR /app/media-worker
COPY services/media-worker/requirements.txt services/media-worker/requirements-ai.txt ./
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements-ai.txt \
    && python -c "import yt_dlp, whisperx, cv2, mediapipe, ultralytics, redis; print('local-prod-one-ai-imports-ok')"
COPY services/media-worker/pyproject.toml ./
COPY services/media-worker/src ./src
RUN pip install --no-deps .

WORKDIR /workspace
COPY --from=node-manifests /usr/local/bin/node /usr/local/bin/node
COPY --from=node-production /workspace/node_modules ./node_modules
COPY --from=node-production /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=node-build /workspace/node_modules/.prisma ./node_modules/.prisma
COPY --from=node-build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=node-build /workspace/apps/api/dist ./apps/api/dist
COPY --from=node-build /workspace/apps/api/prisma ./apps/api/prisma

WORKDIR /srv/clipbr/web
COPY --from=node-build /workspace/apps/web/.next/standalone ./
COPY --from=node-build /workspace/apps/web/.next/static ./apps/web/.next/static

COPY --chmod=755 infra/local-prod-one/entrypoint.sh /usr/local/bin/clipbr-one-entrypoint

RUN mkdir -p /data/postgres /data/redis /data/minio /data/models /data/pipelines /var/log/clipbr \
    && chown -R postgres:postgres /data/postgres

VOLUME ["/data"]
EXPOSE 3000 3001 9000 9001
HEALTHCHECK --interval=15s --timeout=8s --start-period=180s --retries=12 \
  CMD curl -fsS http://127.0.0.1:3001/health/ready >/dev/null && curl -fsS http://127.0.0.1:3000 >/dev/null

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/clipbr-one-entrypoint"]
