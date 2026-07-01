#!/usr/bin/env bash
set -Eeuo pipefail

declare -A PIDS=()

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  local level="$1"
  local service="$2"
  local message="$3"
  printf '{"ts":"%s","level":"%s","service":"%s","message":"%s"}\n' "$(timestamp)" "$level" "$service" "$message"
}

start_logged() {
  local name="$1"
  shift
  log info supervisor "starting ${name}"
  (
    set +e
    "$@" 2>&1 | sed -u "s/^/[${name}] /"
    exit "${PIPESTATUS[0]}"
  ) &
  PIDS["$name"]=$!
}

ensure_running() {
  local name="$1"
  if ! kill -0 "${PIDS[$name]}" 2>/dev/null; then
    log error supervisor "${name} exited before readiness"
    exit 1
  fi
}

shutdown() {
  log warn supervisor "shutdown requested"
  for name in "${!PIDS[@]}"; do
    kill -TERM "${PIDS[$name]}" 2>/dev/null || true
  done
  wait || true
}
trap shutdown INT TERM EXIT

export DATA_DIR="${DATA_DIR:-/data}"
export POSTGRES_DB="${POSTGRES_DB:-clipbr}"
export POSTGRES_USER="${POSTGRES_USER:-clipbr_local}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-clipbr_local_9Tq4xV7mK2pR8sW6}"
export REDIS_PASSWORD="${REDIS_PASSWORD:-clipbr_local_5Hs8nR2qW7mK4vP9}"
export S3_BUCKET="${S3_BUCKET:-clipbr-videos}"
export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-clipbr_local_admin}"
export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-clipbr_local_7Zp9mQ4vN8xK2rT6wF3s}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
export PUBLIC_APP_URL="${PUBLIC_APP_URL:-http://localhost:3330}"
export PUBLIC_API_URL="${PUBLIC_API_URL:-http://localhost:3331}"
export CORS_ORIGIN="${CORS_ORIGIN:-$PUBLIC_APP_URL}"
export CORS_ORIGINS="${CORS_ORIGINS:-$CORS_ORIGIN}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}"
export S3_PUBLIC_ENDPOINT="${S3_PUBLIC_ENDPOINT:-http://localhost:3332}"
export S3_ACCESS_KEY="$S3_ACCESS_KEY_ID"
export S3_SECRET_KEY="$S3_SECRET_ACCESS_KEY"
export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}?schema=public}"
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export REDIS_URL="${REDIS_URL:-redis://:${REDIS_PASSWORD}@127.0.0.1:6379}"
export JWT_SECRET="${JWT_SECRET:-clipbr_one_local_jwt_secret_replace_48_chars_2026}"
export REFRESH_TOKEN_SECRET="${REFRESH_TOKEN_SECRET:-clipbr_one_local_refresh_secret_replace_48_chars_2026}"
export MEDIA_WORKER_TOKEN="${MEDIA_WORKER_TOKEN:-clipbr_one_media_token_replace_48_chars_2026}"
export MEDIA_WORKER_INTERNAL_TOKEN="${MEDIA_WORKER_INTERNAL_TOKEN:-$MEDIA_WORKER_TOKEN}"
export QUEUE_PREFIX="${QUEUE_PREFIX:-clipbr-one}"
export UPLOAD_MODE="${UPLOAD_MODE:-direct}"
export MAX_UPLOAD_SIZE_BYTES="${MAX_UPLOAD_SIZE_BYTES:-5368709120}"
export UPLOAD_MAX_BYTES="${UPLOAD_MAX_BYTES:-$MAX_UPLOAD_SIZE_BYTES}"
export UPLOAD_PART_SIZE_BYTES="${UPLOAD_PART_SIZE_BYTES:-67108864}"
export UPLOAD_QUEUE_SIZE="${UPLOAD_QUEUE_SIZE:-2}"
export UPLOAD_ALLOWED_MIME_TYPES="${UPLOAD_ALLOWED_MIME_TYPES:-video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo}"
export AI_REQUIRED="${AI_REQUIRED:-true}"
export ENABLE_AI="${ENABLE_AI:-true}"
export ENABLE_WHISPERX="${ENABLE_WHISPERX:-true}"
export ENABLE_OPENCV="${ENABLE_OPENCV:-true}"
export ENABLE_MEDIAPIPE="${ENABLE_MEDIAPIPE:-true}"
export ENABLE_YOLO="${ENABLE_YOLO:-true}"
export WHISPERX_MODEL="${WHISPERX_MODEL:-tiny}"
export WHISPERX_DEVICE="${WHISPERX_DEVICE:-cpu}"
export WHISPERX_COMPUTE_TYPE="${WHISPERX_COMPUTE_TYPE:-int8}"
export MEDIA_DIARIZATION_ENABLED="${MEDIA_DIARIZATION_ENABLED:-false}"
export MEDIA_TRANSCRIPTION_BATCH_SIZE="${MEDIA_TRANSCRIPTION_BATCH_SIZE:-1}"
export LLM_PROVIDER="${LLM_PROVIDER:-none}"
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_MODEL="${LLM_MODEL:-openai/gpt-4o-mini}"
export LLM_TIMEOUT_SECONDS="${LLM_TIMEOUT_SECONDS:-45}"
export EMAIL_VERIFICATION_REQUIRED="${EMAIL_VERIFICATION_REQUIRED:-false}"
export TURNSTILE_REQUIRED="${TURNSTILE_REQUIRED:-false}"
export MERCADO_PAGO_ACCESS_TOKEN="${MERCADO_PAGO_ACCESS_TOKEN:-}"
export MERCADO_PAGO_WEBHOOK_SECRET="${MERCADO_PAGO_WEBHOOK_SECRET:-}"
export RESEND_API_KEY="${RESEND_API_KEY:-}"
export EMAIL_FROM="${EMAIL_FROM:-noreply@clipbr.local}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export BUILD_SHA="${BUILD_SHA:-local-prod-one}"
export RETAIN_SOURCE_DOWNLOADS="${RETAIN_SOURCE_DOWNLOADS:-false}"
export MEDIA_WORKER_DATA_DIR="${MEDIA_WORKER_DATA_DIR:-/data/pipelines}"
export HF_HOME="${HF_HOME:-/data/models/huggingface}"
export TORCH_HOME="${TORCH_HOME:-/data/models/torch}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/data/models/cache}"
export MPLCONFIGDIR="${MPLCONFIGDIR:-/data/models/matplotlib}"
export YOLO_CONFIG_DIR="${YOLO_CONFIG_DIR:-/data/models}"

PGDATA="${DATA_DIR}/postgres"
REDIS_DATA="${DATA_DIR}/redis"
MINIO_DATA="${DATA_DIR}/minio"
mkdir -p "$PGDATA" "$REDIS_DATA" "$MINIO_DATA" /data/models /data/pipelines
chown -R postgres:postgres "$PGDATA"

PG_BIN="$(dirname "$(find /usr/lib/postgresql -path '*/bin/initdb' | sort | tail -1)")"
export PATH="$PG_BIN:$PATH"

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  log info postgres "initializing database cluster"
  passfile="$(mktemp)"
  printf '%s' "$POSTGRES_PASSWORD" > "$passfile"
  chown postgres:postgres "$passfile"
  chmod 0600 "$passfile"
  gosu postgres initdb -D "$PGDATA" -U "$POSTGRES_USER" --pwfile="$passfile" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
  rm -f "$passfile"
  {
    echo "listen_addresses = '127.0.0.1'"
    echo "port = 5432"
  } >> "${PGDATA}/postgresql.conf"
  echo "host all all 127.0.0.1/32 scram-sha-256" >> "${PGDATA}/pg_hba.conf"
fi

start_logged postgres gosu postgres postgres -D "$PGDATA"
until PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres >/dev/null 2>&1; do
  log info wait "waiting for postgres"
  sleep 2
done
if ! PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" | grep -q 1; then
  log info postgres "creating database ${POSTGRES_DB}"
  PGPASSWORD="$POSTGRES_PASSWORD" createdb -h 127.0.0.1 -U "$POSTGRES_USER" "$POSTGRES_DB"
fi

start_logged redis redis-server --bind 127.0.0.1 --port 6379 --appendonly yes --dir "$REDIS_DATA" --requirepass "$REDIS_PASSWORD" --protected-mode yes
until redis-cli --no-auth-warning -a "$REDIS_PASSWORD" -h 127.0.0.1 ping | grep -q PONG; do
  log info wait "waiting for redis"
  sleep 2
done

export MINIO_ROOT_USER="$S3_ACCESS_KEY_ID"
export MINIO_ROOT_PASSWORD="$S3_SECRET_ACCESS_KEY"
start_logged minio minio server "$MINIO_DATA" --address 0.0.0.0:9000 --console-address 0.0.0.0:9001
until curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; do
  log info wait "waiting for minio"
  sleep 2
done
mc alias set local http://127.0.0.1:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
mc mb --ignore-existing "local/$S3_BUCKET" >/dev/null
cat > /tmp/minio-cors.json <<EOF
[
  {
    "AllowedOrigins": ["$PUBLIC_APP_URL", "http://localhost:3000", "http://localhost:3330"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
EOF
mc cors set "local/$S3_BUCKET" /tmp/minio-cors.json >/dev/null || log warn minio "could not set bucket CORS"

log info migrate "running prisma migrate deploy"
(cd /workspace && ./node_modules/.bin/prisma migrate deploy --schema=apps/api/prisma/schema.prisma 2>&1 | sed -u 's/^/[migrate] /')

start_logged media-worker uvicorn media_worker.app:app --host 127.0.0.1 --port 8090
until python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health/ready', timeout=8)" >/dev/null 2>&1; do
  ensure_running media-worker
  log info wait "waiting for media-worker ready"
  sleep 5
done

start_logged api bash -lc "cd /workspace && exec node apps/api/dist/main.js"
until curl -fsS http://127.0.0.1:3001/health/ready >/dev/null 2>&1; do
  ensure_running api
  log info wait "waiting for api ready"
  sleep 3
done

start_logged worker bash -lc "cd /workspace && exec node apps/api/dist/worker.js"
until bash -lc "cd /workspace && node apps/api/dist/worker-health.js" >/dev/null 2>&1; do
  ensure_running worker
  log info wait "waiting for worker heartbeat"
  sleep 3
done

export PORT="${WEB_PORT:-3000}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
start_logged web bash -lc "cd /srv/clipbr/web && exec node apps/web/server.js"
until curl -fsS http://127.0.0.1:3000 >/dev/null 2>&1; do
  ensure_running web
  log info wait "waiting for web ready"
  sleep 3
done

log info supervisor "clipbr local-prod-one ready"
log info supervisor "web=${PUBLIC_APP_URL} api=${PUBLIC_API_URL} storage=${S3_PUBLIC_ENDPOINT}"

(
  while true; do
    pg="down"; PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && pg="up"
    rd="down"; redis-cli --no-auth-warning -a "$REDIS_PASSWORD" -h 127.0.0.1 ping >/dev/null 2>&1 && rd="up"
    st="down"; curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1 && st="up"
    mw="down"; python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health/ready', timeout=5)" >/dev/null 2>&1 && mw="up"
    api="down"; curl -fsS http://127.0.0.1:3001/health/ready >/dev/null 2>&1 && api="up"
    web="down"; curl -fsS http://127.0.0.1:3000 >/dev/null 2>&1 && web="up"
    pipe="$(curl -fsS http://127.0.0.1:3001/health/pipeline 2>/dev/null | jq -c '{status, deadLettersOpen, outbox: .outbox.unpublished}' 2>/dev/null || printf '{}')"
    printf '{"ts":"%s","level":"info","service":"heartbeat","postgres":"%s","redis":"%s","storage":"%s","mediaWorker":"%s","api":"%s","web":"%s","pipeline":%s}\n' "$(timestamp)" "$pg" "$rd" "$st" "$mw" "$api" "$web" "$pipe"
    sleep "${HEARTBEAT_INTERVAL_SECONDS:-10}"
  done
) &
PIDS["heartbeat"]=$!

while true; do
  for name in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$name]}" 2>/dev/null; then
      log error supervisor "${name} exited"
      exit 1
    fi
  done
  sleep 5
done
