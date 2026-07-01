#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.vps.yml}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clipbr-vps}"
STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${VPS_BACKUP_DIR:=/srv/clipbr/backups}"

backup_dir="${VPS_BACKUP_DIR}/${STAMP}"
mkdir -p "${backup_dir}"

echo "Backing up PostgreSQL..."
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" --clean --if-exists "${POSTGRES_DB}" \
  | gzip -9 > "${backup_dir}/postgres.sql.gz"

echo "Backing up MinIO bucket..."
BACKUP_STAMP="${STAMP}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" --profile backup run --rm backup

sha256sum "${ENV_FILE}" > "${backup_dir}/env.production.sha256"
if [[ -n "${VPS_BACKUP_GPG_RECIPIENT:-}" ]] && command -v gpg >/dev/null 2>&1; then
  gpg --batch --yes --recipient "${VPS_BACKUP_GPG_RECIPIENT}" --encrypt \
    --output "${backup_dir}/env.production.gpg" "${ENV_FILE}"
else
  echo "Skipping encrypted env backup. Set VPS_BACKUP_GPG_RECIPIENT and install gpg to enable it." >&2
fi

find "${VPS_BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +35 -print -exec rm -rf {} +

echo "Backup finished: ${backup_dir}"
