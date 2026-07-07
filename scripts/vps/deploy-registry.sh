#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clipbr-vps}"
OBSERVE_READY_SECONDS="${OBSERVE_READY_SECONDS:-0}"

BASE_COMPOSE_FILE="${BASE_COMPOSE_FILE:-${ROOT_DIR}/docker-compose.vps.yml}"
IMAGE_COMPOSE_FILE="${IMAGE_COMPOSE_FILE:-${ROOT_DIR}/docker-compose.vps.images.yml}"

: "${API_IMAGE:?API_IMAGE is required}"
: "${MIGRATION_IMAGE:?MIGRATION_IMAGE is required}"
: "${WEB_IMAGE:?WEB_IMAGE is required}"
: "${MEDIA_IMAGE:?MEDIA_IMAGE is required}"

DEPLOY_BUILD_SHA="${BUILD_SHA:-}"

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

if [[ -n "${DEPLOY_BUILD_SHA}" ]]; then
  BUILD_SHA="${DEPLOY_BUILD_SHA}"
  export BUILD_SHA
fi

: "${APP_DOMAIN:?APP_DOMAIN is required}"
: "${VPS_DATA_DIR:=/srv/clipbr/data}"
: "${VPS_BACKUP_DIR:=/srv/clipbr/backups}"

if [[ "${APP_ENV:-production}" == "production" ]]; then
  if [[ "${DEPLOY_SOURCE:-}" != "github-actions" || -z "${DEPLOY_GITHUB_RUN_ID:-}" ]]; then
    if [[ "${ALLOW_MANUAL_PRODUCTION_DEPLOY:-false}" != "true" ]]; then
      echo "Production deploys must run through GitHub Actions. Re-run the VPS CI/CD workflow instead of deploying from a shell." >&2
      echo "Break-glass only: set ALLOW_MANUAL_PRODUCTION_DEPLOY=true with an incident note." >&2
      exit 1
    fi
    echo "WARNING: manual production deploy allowed by ALLOW_MANUAL_PRODUCTION_DEPLOY=true" >&2
  fi
fi

if [[ "${APP_ENV:-production}" == "production" && -n "${TURNSTILE_BYPASS_TOKEN:-}" && "${ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION:-false}" != "true" ]]; then
  echo "TURNSTILE_BYPASS_TOKEN is set in production. Clear it, or set ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION=true only for a private smoke window." >&2
  exit 1
fi

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  : "${GHCR_USERNAME:?GHCR_USERNAME is required when GHCR_TOKEN is set}"
  echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin >/dev/null
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

# The media-worker image runs as uid/gid 10001. Bind-mounted media data must be
# writable by that user, otherwise pipeline stages fail when creating
# /data/pipelines and using /data/models. Existing model caches can contain
# files created by older containers/root, so never let a best-effort permission
# repair on cache files abort the deploy. Runtime readiness validates the
# writable paths after the containers are started.
mkdir -p "${VPS_DATA_DIR}/media/pipelines" "${VPS_DATA_DIR}/media/models" "${VPS_DATA_DIR}/media/cookies"
if ! chown -R 10001:10001 "${VPS_DATA_DIR}/media" 2>/dev/null; then
  chmod a+rwX "${VPS_DATA_DIR}/media" "${VPS_DATA_DIR}/media/models" "${VPS_DATA_DIR}/media/cookies" 2>/dev/null || true
  chmod -R a+rwX "${VPS_DATA_DIR}/media/pipelines" 2>/dev/null || true
  find "${VPS_DATA_DIR}/media" -maxdepth 2 -type d -exec chmod a+rwX {} + 2>/dev/null || true
fi

compose_args=(
  --env-file "${ENV_FILE}"
  -f "${BASE_COMPOSE_FILE}"
  -f "${IMAGE_COMPOSE_FILE}"
  -p "${PROJECT_NAME}"
)

docker compose "${compose_args[@]}" config --quiet
docker compose "${compose_args[@]}" pull --ignore-pull-failures
docker compose "${compose_args[@]}" up --detach --wait --no-build
docker compose "${compose_args[@]}" ps

echo "Waiting for public TLS endpoints..."
for endpoint in "https://api.${APP_DOMAIN}/health/ready" "https://api.${APP_DOMAIN}/health/pipeline" "https://${APP_DOMAIN}" "https://storage.${APP_DOMAIN}/minio/health/live"; do
  for attempt in $(seq 1 60); do
    if curl -fsS "${endpoint}" >/dev/null; then
      echo "OK ${endpoint}"
      break
    fi
    if [[ "${attempt}" == "60" ]]; then
      echo "Endpoint did not become ready: ${endpoint}" >&2
      docker compose "${compose_args[@]}" logs --tail=200
      exit 1
    fi
    sleep 5
  done
done

grafana_host="grafana.${APP_DOMAIN}"
if [[ "${REQUIRE_GRAFANA_PUBLIC_ENDPOINT:-false}" != "true" ]] && ! timeout 5 getent hosts "${grafana_host}" >/dev/null 2>&1; then
  echo "Skipping https://${grafana_host}: DNS is not resolving yet. Set REQUIRE_GRAFANA_PUBLIC_ENDPOINT=true to make this blocking."
else
  grafana_status="$(curl -sS -o /dev/null -w '%{http_code}' "https://${grafana_host}" || true)"
  case "${grafana_status}" in
    401|302|200) echo "OK https://${grafana_host} auth flow HTTP ${grafana_status}" ;;
    *) echo "Expected Grafana public endpoint to respond with auth/login flow, got HTTP ${grafana_status}" >&2; exit 1 ;;
  esac
fi

metrics_status="$(curl -sS -o /dev/null -w '%{http_code}' "https://api.${APP_DOMAIN}/metrics" || true)"
case "${metrics_status}" in
  404) echo "OK public API /metrics is blocked" ;;
  *) echo "Expected public API /metrics to stay blocked with 404, got HTTP ${metrics_status}" >&2; exit 1 ;;
esac

if [[ "${OBSERVE_READY_SECONDS}" != "0" ]]; then
  echo "Observing containers for ${OBSERVE_READY_SECONDS}s..."
  sleep "${OBSERVE_READY_SECONDS}"
  ids="$(docker compose "${compose_args[@]}" ps -q)"
  test -n "${ids}"
  for id in ${ids}; do
    name="$(docker inspect -f '{{.Name}}' "${id}" | sed 's#^/##')"
    restart_count="$(docker inspect -f '{{.RestartCount}}' "${id}")"
    state_status="$(docker inspect -f '{{.State.Status}}' "${id}")"
    echo "${name} restart=${restart_count} status=${state_status}"
    test "${restart_count}" = "0"
    test "${state_status}" = "running"
  done
fi

curl -fsS "https://api.${APP_DOMAIN}/health/ready"
printf '\n'
curl -fsS "https://api.${APP_DOMAIN}/health/pipeline"
printf '\n'
echo "Registry deploy finished."
