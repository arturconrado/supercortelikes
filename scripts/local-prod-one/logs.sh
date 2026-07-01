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

docker compose "${args[@]}" logs -f --tail="${TAIL:-200}" clipbr
