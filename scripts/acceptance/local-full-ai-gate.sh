#!/usr/bin/env bash
set -euo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-clipbr-local-full-ai-gate}"
COMPOSE_FILE="${ACCEPTANCE_COMPOSE_FILE:-docker-compose.local.yml}"
API_PORT="${PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
MINIO_API_PORT="${MINIO_API_PORT:-9000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"

export COMPOSE_PROJECT_NAME="$PROJECT"
export ACCEPTANCE_COMPOSE_FILE="$COMPOSE_FILE"
export PRODUCT_E2E_COMPOSE_FILE="$COMPOSE_FILE"
export ACCEPTANCE_MEDIA_PROFILE="local-full"
export PRODUCT_E2E_MEDIA_PROFILE="local-full"
export ACCEPTANCE_UPLOAD_MODE="${ACCEPTANCE_UPLOAD_MODE:-direct}"
export PRODUCT_E2E_API_URL="${PRODUCT_E2E_API_URL:-http://localhost:${API_PORT}}"
export PRODUCT_E2E_WEB_URL="${PRODUCT_E2E_WEB_URL:-http://localhost:${WEB_PORT}}"
export DATABASE_URL="${DATABASE_URL:-postgresql://clipbr_local:clipbr_local_9Tq4xV7mK2pR8sW6@localhost:${POSTGRES_PORT}/clipbr?schema=public}"
export S3_PUBLIC_ENDPOINT="${S3_PUBLIC_ENDPOINT:-http://localhost:${MINIO_API_PORT}}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:${API_PORT}}"
export PUBLIC_API_URL="${PUBLIC_API_URL:-http://localhost:${API_PORT}}"
export PUBLIC_APP_URL="${PUBLIC_APP_URL:-http://localhost:${WEB_PORT}}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:${WEB_PORT}}"
export PORT="$API_PORT"
export WEB_PORT="$WEB_PORT"
export POSTGRES_PORT="$POSTGRES_PORT"
export REDIS_PORT="$REDIS_PORT"
export MINIO_API_PORT="$MINIO_API_PORT"
export MINIO_CONSOLE_PORT="$MINIO_CONSOLE_PORT"

docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --profile local-full up --build --detach --wait
node scripts/acceptance/product-e2e.mjs
