#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.vps.yml}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clipbr-vps}"
BACKUP_STAMP="${1:-}"

if [[ -z "${BACKUP_STAMP}" ]]; then
  echo "Usage: $0 <UTC backup stamp>" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${VPS_BACKUP_DIR:=/srv/clipbr/backups}"
BACKUP_DIR="${VPS_BACKUP_DIR}/${BACKUP_STAMP}"

test -s "${BACKUP_DIR}/postgres.sql.gz"
test -d "${BACKUP_DIR}/minio"

if [[ "${CONFIRM_RESTORE:-}" != "I_UNDERSTAND_DATA_WILL_BE_REPLACED" ]]; then
  echo "Restore is destructive. Set CONFIRM_RESTORE=I_UNDERSTAND_DATA_WILL_BE_REPLACED to continue." >&2
  exit 1
fi

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" exec -T postgres \
  psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${POSTGRES_DB}' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";" \
  -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"

gzip -dc "${BACKUP_DIR}/postgres.sql.gz" | \
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1

echo "PostgreSQL restored from ${BACKUP_DIR}. MinIO objects are available for a bucket mirror restore; do not overwrite live objects until the database verification passes."
