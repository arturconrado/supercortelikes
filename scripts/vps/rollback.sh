#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <git-ref-or-sha>" >&2
  exit 1
fi

TARGET_REF="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.vps.yml}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clipbr-vps}"
SKIP_BACKUP="${SKIP_BACKUP:-false}"

cd "${ROOT_DIR}"

if [[ "${SKIP_BACKUP}" != "true" ]]; then
  BACKUP_STAMP="pre-rollback-$(date -u +%Y%m%dT%H%M%SZ)" "${ROOT_DIR}/scripts/vps/backup.sh"
fi

current_ref="$(git rev-parse --short HEAD)"
echo "Current ref: ${current_ref}"
echo "Rolling back to: ${TARGET_REF}"

git fetch --all --tags --prune
git checkout "${TARGET_REF}"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" up --build --detach --wait
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" ps

RUN_PRODUCT_E2E=false RUN_5G=false OBSERVE_SECONDS=60 "${ROOT_DIR}/scripts/vps/smoke.sh"

echo "Rollback finished. Previous ref was ${current_ref}."
