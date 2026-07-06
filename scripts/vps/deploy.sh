#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.vps.yml}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clipbr-vps}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Copy .env.vps.example to .env.production and fill secrets." >&2
  exit 1
fi

if grep -Eq 'DOMINIO\.com|CHANGE_ME_' "${ENV_FILE}"; then
  echo "${ENV_FILE} still contains placeholder values." >&2
  exit 1
fi

env_mode="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || true)"
if [[ -n "${env_mode}" && "${env_mode: -2}" != "00" ]]; then
  echo "${ENV_FILE} must not be readable by group/others. Run: chmod 600 ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

: "${APP_DOMAIN:?APP_DOMAIN is required}"
: "${VPS_DATA_DIR:=/srv/clipbr/data}"
: "${VPS_BACKUP_DIR:=/srv/clipbr/backups}"

if [[ "${APP_ENV:-production}" == "production" && -n "${TURNSTILE_BYPASS_TOKEN:-}" && "${ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION:-false}" != "true" ]]; then
  echo "TURNSTILE_BYPASS_TOKEN is set in production. Clear it, or set ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION=true only for a private smoke window." >&2
  exit 1
fi

mkdir -p \
  "${VPS_DATA_DIR}/postgres" \
  "${VPS_DATA_DIR}/redis" \
  "${VPS_DATA_DIR}/minio" \
  "${VPS_DATA_DIR}/media" \
  "${VPS_DATA_DIR}/caddy/data" \
  "${VPS_DATA_DIR}/caddy/config" \
  "${VPS_DATA_DIR}/observability/prometheus" \
  "${VPS_DATA_DIR}/observability/grafana" \
  "${VPS_DATA_DIR}/observability/loki" \
  "${VPS_BACKUP_DIR}"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" config --quiet
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" up --build --detach --wait
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" ps

echo "Waiting for public TLS endpoints..."
for path in "https://api.${APP_DOMAIN}/health/ready" "https://api.${APP_DOMAIN}/health/pipeline" "https://${APP_DOMAIN}" "https://storage.${APP_DOMAIN}/minio/health/live"; do
  for attempt in $(seq 1 60); do
    if curl -fsS "${path}" >/dev/null; then
      echo "OK ${path}"
      break
    fi
    if [[ "${attempt}" == "60" ]]; then
      echo "Endpoint did not become ready: ${path}" >&2
      exit 1
    fi
    sleep 5
  done
done

grafana_status="$(curl -sS -o /dev/null -w '%{http_code}' "https://grafana.${APP_DOMAIN}" || true)"
case "${grafana_status}" in
  401|302|200) echo "OK https://grafana.${APP_DOMAIN} auth flow HTTP ${grafana_status}" ;;
  *) echo "Expected Grafana public endpoint to respond with auth/login flow, got HTTP ${grafana_status}" >&2; exit 1 ;;
esac

metrics_status="$(curl -sS -o /dev/null -w '%{http_code}' "https://api.${APP_DOMAIN}/metrics" || true)"
case "${metrics_status}" in
  404) echo "OK public API /metrics is blocked" ;;
  *) echo "Expected public API /metrics to stay blocked with 404, got HTTP ${metrics_status}" >&2; exit 1 ;;
esac

echo "Deploy finished. Run scripts/vps/smoke.sh for the full product gate."
