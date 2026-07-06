#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.vps.yml}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clipbr-vps}"

errors=0
warnings=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  errors=$((errors + 1))
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
  warnings=$((warnings + 1))
}

ok() {
  printf 'OK: %s\n' "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "missing command: $1"
  fi
}

if [[ ! -f "${ENV_FILE}" ]]; then
  fail "missing ${ENV_FILE}. Copy .env.vps.example to .env.production first."
else
  if grep -Eq 'DOMINIO\.com|CHANGE_ME_' "${ENV_FILE}"; then
    fail "${ENV_FILE} still contains placeholder values."
  fi
  env_mode="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${ENV_FILE}" 2>/dev/null || echo unknown)"
  case "${env_mode}" in
    400|600) ok "${ENV_FILE} permissions are restrictive (${env_mode})" ;;
    unknown) warn "could not inspect ${ENV_FILE} permissions" ;;
    *) fail "${ENV_FILE} permissions are ${env_mode}; use chmod 600 ${ENV_FILE}" ;;
  esac
fi

set -a
# shellcheck disable=SC1090
[[ -f "${ENV_FILE}" ]] && . "${ENV_FILE}"
set +a

: "${APP_DOMAIN:=}"
: "${VPS_PROVIDER:=digitalocean}"
: "${VPS_SIZE_PROFILE:=budget}"
: "${VPS_DATA_DIR:=/srv/clipbr/data}"

case "${VPS_SIZE_PROFILE}" in
  budget)
    PROFILE_MIN_CPUS=4
    PROFILE_RECOMMENDED_CPUS=8
    PROFILE_MIN_MEMORY_GB=7
    PROFILE_MIN_DATA_GB=120
    ;;
  standard)
    PROFILE_MIN_CPUS=8
    PROFILE_RECOMMENDED_CPUS=8
    PROFILE_MIN_MEMORY_GB=15
    PROFILE_MIN_DATA_GB=250
    ;;
  performance)
    PROFILE_MIN_CPUS=16
    PROFILE_RECOMMENDED_CPUS=16
    PROFILE_MIN_MEMORY_GB=28
    PROFILE_MIN_DATA_GB=300
    ;;
  *)
    echo "Invalid VPS_SIZE_PROFILE=${VPS_SIZE_PROFILE}. Use budget, standard, or performance." >&2
    exit 1
    ;;
esac

MIN_CPUS="${MIN_CPUS:-${PROFILE_MIN_CPUS}}"
RECOMMENDED_CPUS="${RECOMMENDED_CPUS:-${PROFILE_RECOMMENDED_CPUS}}"
MIN_MEMORY_GB="${MIN_MEMORY_GB:-${PROFILE_MIN_MEMORY_GB}}"
MIN_DATA_GB="${MIN_DATA_GB:-${PROFILE_MIN_DATA_GB}}"

require_cmd docker
require_cmd curl

ok "VPS provider target is ${VPS_PROVIDER}"
ok "VPS size profile is ${VPS_SIZE_PROFILE} (min ${MIN_CPUS} CPU, ${MIN_MEMORY_GB} GiB RAM, ${MIN_DATA_GB} GiB free storage)"

if command -v nproc >/dev/null 2>&1; then
  cpus="$(nproc)"
else
  cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"
fi
if [[ "${cpus}" -lt "${MIN_CPUS}" ]]; then
  fail "CPU count is ${cpus}; minimum is ${MIN_CPUS}"
elif [[ "${cpus}" -lt "${RECOMMENDED_CPUS}" ]]; then
  warn "CPU count is ${cpus}; recommended for faster media jobs is ${RECOMMENDED_CPUS}"
else
  ok "CPU count is ${cpus}"
fi

if [[ -r /proc/meminfo ]]; then
  memory_gb="$(awk '/MemTotal/ { printf "%d", $2 / 1024 / 1024 }' /proc/meminfo 2>/dev/null || echo 0)"
elif command -v sysctl >/dev/null 2>&1; then
  memory_gb="$(sysctl -n hw.memsize 2>/dev/null | awk '{ printf "%d", $1 / 1024 / 1024 / 1024 }')"
else
  memory_gb=0
fi
if [[ "${memory_gb}" -lt "${MIN_MEMORY_GB}" ]]; then
  fail "RAM is ${memory_gb} GiB; minimum for this all-in-one profile is ${MIN_MEMORY_GB} GiB"
else
  ok "RAM is ${memory_gb} GiB"
fi

probe_dir="${VPS_DATA_DIR}"
while [[ ! -e "${probe_dir}" && "${probe_dir}" != "/" ]]; do
  probe_dir="$(dirname "${probe_dir}")"
done
data_gb="$(df -Pk "${probe_dir}" 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1024 / 1024 }' || true)"
if [[ -z "${data_gb}" || "${data_gb}" -lt "${MIN_DATA_GB}" ]]; then
  fail "available storage at ${probe_dir} for ${VPS_DATA_DIR} is ${data_gb:-unknown} GiB; minimum is ${MIN_DATA_GB} GiB"
else
  ok "available storage at ${probe_dir} for ${VPS_DATA_DIR} is ${data_gb} GiB"
fi

if command -v findmnt >/dev/null 2>&1; then
  if findmnt -T "${VPS_DATA_DIR}" >/dev/null 2>&1; then
    ok "${VPS_DATA_DIR} is on a mounted filesystem"
  else
    warn "could not confirm mount for ${VPS_DATA_DIR}; if this provider supports block volumes, prefer one for app data when usage grows"
  fi
fi

case "${VPS_PROVIDER}" in
  digitalocean)
    if curl -fsS --max-time 2 http://169.254.169.254/metadata/v1/id >/dev/null 2>&1; then
      region="$(curl -fsS --max-time 2 http://169.254.169.254/metadata/v1/region 2>/dev/null || true)"
      ok "DigitalOcean metadata is reachable${region:+, region=${region}}"
    else
      warn "DigitalOcean metadata endpoint not reachable; skip if running outside a Droplet"
    fi
    ;;
  hetzner|ovh|vultr|akamai|generic)
    warn "provider metadata check skipped for VPS_PROVIDER=${VPS_PROVIDER}"
    ;;
  *)
    warn "unknown VPS_PROVIDER=${VPS_PROVIDER}; provider metadata check skipped"
    ;;
esac

if [[ -n "${APP_DOMAIN}" ]] && command -v getent >/dev/null 2>&1; then
  public_ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  for host in "${APP_DOMAIN}" "www.${APP_DOMAIN}" "api.${APP_DOMAIN}" "grafana.${APP_DOMAIN}" "storage.${APP_DOMAIN}"; do
    resolved="$(getent ahostsv4 "${host}" 2>/dev/null | awk '{ print $1; exit }')"
    if [[ -z "${resolved}" ]]; then
      warn "DNS does not resolve ${host} yet"
    elif [[ -n "${public_ip}" && "${resolved}" != "${public_ip}" ]]; then
      warn "DNS for ${host} resolves to ${resolved}, but server public IP appears to be ${public_ip}"
    else
      ok "DNS ${host} -> ${resolved}"
    fi
  done
fi

if docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" config --quiet; then
  ok "docker compose config is valid"
else
  fail "docker compose config failed"
fi

if [[ "${errors}" -gt 0 ]]; then
  printf 'Preflight failed with %d error(s) and %d warning(s).\n' "${errors}" "${warnings}" >&2
  exit 1
fi

printf 'Preflight passed with %d warning(s).\n' "${warnings}"
