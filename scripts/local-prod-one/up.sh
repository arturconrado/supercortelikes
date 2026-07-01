#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${COMPOSE_PROJECT_NAME:-clipbr-one}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.one.yml}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.one}"

args=(-f "$COMPOSE_FILE" -p "$PROJECT")
if [ -f "$ENV_FILE" ]; then
  args=(--env-file "$ENV_FILE" "${args[@]}")
fi

echo "[clipbr-one] starting all-in-one local production-like container"
docker compose "${args[@]}" up --build --detach --wait
echo "[clipbr-one] ready. Streaming logs; keep this terminal open."
echo "[clipbr-one] web:     http://localhost:${ONE_WEB_PORT:-3330}"
echo "[clipbr-one] api:     http://localhost:${ONE_API_PORT:-3331}"
echo "[clipbr-one] storage: http://localhost:${ONE_STORAGE_PORT:-3332}"
docker compose "${args[@]}" logs -f --tail=200 clipbr
