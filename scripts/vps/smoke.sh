#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.vps.yml}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clipbr-vps}"
RUN_PRODUCT_E2E="${RUN_PRODUCT_E2E:-true}"
RUN_5G="${RUN_5G:-false}"
OBSERVE_SECONDS="${OBSERVE_SECONDS:-600}"

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

: "${APP_DOMAIN:?APP_DOMAIN is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_LOCAL_PORT:=55432}"

curl -fsS "https://api.${APP_DOMAIN}/health/ready"
printf '\n'
curl -fsS "https://api.${APP_DOMAIN}/health/pipeline"
printf '\n'
curl -fsSI "https://${APP_DOMAIN}" >/dev/null
www_location="$(curl -fsSI "https://www.${APP_DOMAIN}" | awk 'BEGIN{IGNORECASE=1} /^location:/ {print $2}' | tr -d '\r')"
case "${www_location}" in
  "https://${APP_DOMAIN}"|"https://${APP_DOMAIN}/"|"https://${APP_DOMAIN}/"*) ;;
  *) echo "Expected https://www.${APP_DOMAIN} to redirect to https://${APP_DOMAIN}, got: ${www_location:-<missing>}" >&2; exit 1 ;;
esac
curl -fsS "https://storage.${APP_DOMAIN}/minio/health/live" >/dev/null

if [[ "${RUN_PRODUCT_E2E}" == "true" ]]; then
  if [[ "${EMAIL_VERIFICATION_REQUIRED:-false}" == "true" && -z "${PRODUCT_E2E_EMAIL:-}" ]]; then
    echo "EMAIL_VERIFICATION_REQUIRED=true. Set PRODUCT_E2E_EMAIL and PRODUCT_E2E_PASSWORD for an already verified smoke account, or run a separate verified-email flow before the full product E2E." >&2
    exit 1
  fi
  PRODUCT_E2E_API_URL="https://api.${APP_DOMAIN}" \
  PRODUCT_E2E_WEB_URL="https://${APP_DOMAIN}" \
  PRODUCT_E2E_COMPOSE_FILE="${COMPOSE_FILE}" \
  PRODUCT_E2E_MEDIA_PROFILE="vps" \
  PRODUCT_E2E_TURNSTILE_TOKEN="${PRODUCT_E2E_TURNSTILE_TOKEN:-${TURNSTILE_BYPASS_TOKEN:-}}" \
  PRODUCT_E2E_PASSWORD="${PRODUCT_E2E_PASSWORD:-ProductGate123!}" \
  DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_LOCAL_PORT}/${POSTGRES_DB}?schema=public" \
  COMPOSE_PROJECT_NAME="${PROJECT_NAME}" \
  npm run acceptance:product
fi

if [[ "${RUN_5G}" == "true" ]]; then
  if [[ "${EMAIL_VERIFICATION_REQUIRED:-false}" == "true" && -z "${ACCEPTANCE_ACCESS_TOKEN:-}" && -z "${PRODUCT_E2E_EMAIL:-}" ]]; then
    echo "EMAIL_VERIFICATION_REQUIRED=true. Set ACCEPTANCE_ACCESS_TOKEN or PRODUCT_E2E_EMAIL/PRODUCT_E2E_PASSWORD before the 5 GiB gate." >&2
    exit 1
  fi
  ACCEPTANCE_API_URL="https://api.${APP_DOMAIN}" \
  ACCEPTANCE_EMAIL="${ACCEPTANCE_EMAIL:-${PRODUCT_E2E_EMAIL:-}}" \
  ACCEPTANCE_PASSWORD="${ACCEPTANCE_PASSWORD:-${PRODUCT_E2E_PASSWORD:-ProductGate123!}}" \
  ACCEPTANCE_TURNSTILE_TOKEN="${ACCEPTANCE_TURNSTILE_TOKEN:-${PRODUCT_E2E_TURNSTILE_TOKEN:-${TURNSTILE_BYPASS_TOKEN:-}}}" \
  npm run acceptance:direct:5g
fi

echo "Observing containers for ${OBSERVE_SECONDS}s..."
sleep "${OBSERVE_SECONDS}"

ids="$(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" ps -q)"
test -n "${ids}"
for id in ${ids}; do
  name="$(docker inspect -f '{{.Name}}' "${id}" | sed 's#^/##')"
  restart_count="$(docker inspect -f '{{.RestartCount}}' "${id}")"
  state_status="$(docker inspect -f '{{.State.Status}}' "${id}")"
  exit_code="$(docker inspect -f '{{.State.ExitCode}}' "${id}")"
  echo "${name} restart=${restart_count} status=${state_status} exit=${exit_code}"
  test "${restart_count}" = "0"
  test "${state_status}" = "running" || test "${exit_code}" = "0"
done

curl -fsS "https://api.${APP_DOMAIN}/health/ready"
printf '\n'
curl -fsS "https://api.${APP_DOMAIN}/health/pipeline"
printf '\n'
echo "Smoke finished."
