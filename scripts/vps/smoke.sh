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
sse_status="$(curl -fsS -o /dev/null -w '%{http_code}' "https://api.${APP_DOMAIN}/videos/00000000-0000-4000-8000-000000000000/events" || true)"
case "${sse_status}" in
  401|403) ;;
  *) echo "Expected authenticated SSE endpoint to reject anonymous access, got HTTP ${sse_status}" >&2; exit 1 ;;
esac
curl -fsSI "https://${APP_DOMAIN}" >/dev/null
www_location="$(curl -fsSI "https://www.${APP_DOMAIN}" | awk 'BEGIN{IGNORECASE=1} /^location:/ {print $2}' | tr -d '\r')"
case "${www_location}" in
  "https://${APP_DOMAIN}"|"https://${APP_DOMAIN}/"|"https://${APP_DOMAIN}/"*) ;;
  *) echo "Expected https://www.${APP_DOMAIN} to redirect to https://${APP_DOMAIN}, got: ${www_location:-<missing>}" >&2; exit 1 ;;
esac
curl -fsS "https://storage.${APP_DOMAIN}/minio/health/live" >/dev/null
grafana_host="grafana.${APP_DOMAIN}"
if [[ "${REQUIRE_GRAFANA_PUBLIC_ENDPOINT:-false}" != "true" ]] && ! timeout 5 getent hosts "${grafana_host}" >/dev/null 2>&1; then
  echo "Skipping https://${grafana_host}: DNS is not resolving yet. Set REQUIRE_GRAFANA_PUBLIC_ENDPOINT=true to make this blocking."
else
  grafana_status="$(curl -sS -o /dev/null -w '%{http_code}' "https://${grafana_host}" || true)"
  case "${grafana_status}" in
    401|302|200) ;;
    *) echo "Expected Grafana public endpoint to respond with auth/login flow, got HTTP ${grafana_status}" >&2; exit 1 ;;
  esac
fi
metrics_status="$(curl -sS -o /dev/null -w '%{http_code}' "https://api.${APP_DOMAIN}/metrics" || true)"
case "${metrics_status}" in
  404) ;;
  *) echo "Expected public API /metrics to stay blocked with 404, got HTTP ${metrics_status}" >&2; exit 1 ;;
esac

api_container="$(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" ps -q api)"
test -n "${api_container}"
api_image="$(docker inspect -f '{{.Config.Image}}' "${api_container}")"
test -n "${api_image}"
database_url="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_LOCAL_PORT}/${POSTGRES_DB}?schema=public"

run_node_acceptance() {
  local script_path="$1"
  shift
  docker run --rm \
    --network host \
    --user 0:0 \
    --mount "type=bind,src=${script_path},dst=/workspace/acceptance.mjs,readonly" \
    "$@" \
    "${api_image}" \
    node /workspace/acceptance.mjs
}

if [[ "${RUN_PRODUCT_E2E}" == "true" ]]; then
  product_e2e_email="${PRODUCT_E2E_EMAIL:-}"
  product_e2e_password="${PRODUCT_E2E_PASSWORD:-}"
  if [[ -z "${product_e2e_email}" ]]; then
    product_e2e_email="product-e2e@clipbr.test"
    product_e2e_password="Aa1-$(tr -d '-' </proc/sys/kernel/random/uuid)"
    run_node_acceptance "${ROOT_DIR}/scripts/acceptance/provision-product-e2e-account.mjs" \
      --env "DATABASE_URL=${database_url}" \
      --env "PRODUCT_E2E_EMAIL=${product_e2e_email}" \
      --env "PRODUCT_E2E_PASSWORD=${product_e2e_password}" \
      --env "PRODUCT_E2E_TERMS_VERSION=${TERMS_VERSION:-terms-2026-06}" \
      --env "PRODUCT_E2E_PRIVACY_VERSION=${PRIVACY_VERSION:-privacy-2026-06}"
  elif [[ -z "${product_e2e_password}" ]]; then
    echo "PRODUCT_E2E_PASSWORD is required when PRODUCT_E2E_EMAIL is supplied." >&2
    exit 1
  fi
  docker run --rm \
    --network host \
    --user 0:0 \
    --mount "type=bind,src=${ROOT_DIR}/scripts/acceptance/product-e2e.mjs,dst=/workspace/acceptance.mjs,readonly" \
    --env "DATABASE_URL=${database_url}" \
    --env "PRODUCT_E2E_API_URL=https://api.${APP_DOMAIN}" \
    --env "PRODUCT_E2E_WEB_URL=https://${APP_DOMAIN}" \
    --env "PRODUCT_E2E_EMAIL=${product_e2e_email}" \
    --env "PRODUCT_E2E_PASSWORD=${product_e2e_password}" \
    --env "PRODUCT_E2E_TURNSTILE_TOKEN=${PRODUCT_E2E_TURNSTILE_TOKEN:-}" \
    --env "PRODUCT_E2E_CLEANUP=true" \
    --env "PRODUCT_E2E_TERMS_VERSION=${TERMS_VERSION:-terms-2026-06}" \
    --env "PRODUCT_E2E_PRIVACY_VERSION=${PRIVACY_VERSION:-privacy-2026-06}" \
    "${api_image}" \
    sh -ec 'apk add --no-cache ffmpeg >/dev/null && node /workspace/acceptance.mjs'
fi

if [[ "${RUN_5G}" == "true" ]]; then
  acceptance_email="${ACCEPTANCE_EMAIL:-${product_e2e_email:-${PRODUCT_E2E_EMAIL:-}}}"
  acceptance_password="${ACCEPTANCE_PASSWORD:-${product_e2e_password:-${PRODUCT_E2E_PASSWORD:-}}}"
  if [[ -z "${ACCEPTANCE_ACCESS_TOKEN:-}" && ( -z "${acceptance_email}" || -z "${acceptance_password}" ) ]]; then
    echo "Set ACCEPTANCE_ACCESS_TOKEN or run the product E2E/provide PRODUCT_E2E_EMAIL and PRODUCT_E2E_PASSWORD before the 5 GiB gate." >&2
    exit 1
  fi
  run_node_acceptance "${ROOT_DIR}/scripts/acceptance/direct-upload-5g.mjs" \
    --env "ACCEPTANCE_API_URL=https://api.${APP_DOMAIN}" \
    --env "ACCEPTANCE_ACCESS_TOKEN=${ACCEPTANCE_ACCESS_TOKEN:-}" \
    --env "ACCEPTANCE_EMAIL=${acceptance_email}" \
    --env "ACCEPTANCE_PASSWORD=${acceptance_password}" \
    --env "ACCEPTANCE_TURNSTILE_TOKEN=${ACCEPTANCE_TURNSTILE_TOKEN:-${PRODUCT_E2E_TURNSTILE_TOKEN:-}}"
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
