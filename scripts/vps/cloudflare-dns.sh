#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

cf_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local url="https://api.cloudflare.com/client/v4${path}"

  if [[ -n "${data}" ]]; then
    curl -fsS -X "${method}" "${url}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "${data}"
  else
    curl -fsS -X "${method}" "${url}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json"
  fi
}

json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

resolve_zone_id() {
  if [[ -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
    printf '%s\n' "${CLOUDFLARE_ZONE_ID}"
    return 0
  fi

  : "${CLOUDFLARE_ZONE_NAME:?CLOUDFLARE_ZONE_NAME or CLOUDFLARE_ZONE_ID is required}"
  cf_api GET "/zones?name=${CLOUDFLARE_ZONE_NAME}&status=active" |
    node -e "
      const fs = require('fs');
      const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
      if (!payload.success) {
        console.error(JSON.stringify(payload.errors || payload, null, 2));
        process.exit(1);
      }
      const zones = payload.result || [];
      if (zones.length !== 1) {
        console.error('Expected exactly one active Cloudflare zone for ${CLOUDFLARE_ZONE_NAME}, found ' + zones.length);
        process.exit(1);
      }
      console.log(zones[0].id);
    "
}

record_name_for() {
  local host="$1"
  local zone="$2"
  if [[ "${host}" == "${zone}" ]]; then
    printf '@\n'
  else
    printf '%s\n' "${host%.${zone}}"
  fi
}

upsert_a_record() {
  local zone_id="$1"
  local zone_name="$2"
  local host="$3"
  local ip="$4"
  local proxied="$5"
  local ttl="$6"

  local escaped_name escaped_ip record_name existing record_id body
  record_name="$(record_name_for "${host}" "${zone_name}")"
  escaped_name="$(json_escape "${host}")"
  escaped_ip="$(json_escape "${ip}")"

  existing="$(
    cf_api GET "/zones/${zone_id}/dns_records?type=A&name=${host}" |
      node -e "
        const fs = require('fs');
        const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
        if (!payload.success) {
          console.error(JSON.stringify(payload.errors || payload, null, 2));
          process.exit(1);
        }
        const records = payload.result || [];
        console.log(records[0]?.id || '');
      "
  )"

  body="{\"type\":\"A\",\"name\":${escaped_name},\"content\":${escaped_ip},\"ttl\":${ttl},\"proxied\":${proxied}}"

  if [[ -n "${existing}" ]]; then
    record_id="${existing}"
    cf_api PUT "/zones/${zone_id}/dns_records/${record_id}" "${body}" >/dev/null
    echo "Cloudflare DNS updated: ${record_name}.${zone_name} -> ${ip} proxied=${proxied}"
  else
    cf_api POST "/zones/${zone_id}/dns_records" "${body}" >/dev/null
    echo "Cloudflare DNS created: ${record_name}.${zone_name} -> ${ip} proxied=${proxied}"
  fi
}

require_cmd curl
require_cmd node

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_RECORD_IP:?CLOUDFLARE_RECORD_IP is required}"

zone_name="${CLOUDFLARE_ZONE_NAME:-${APP_DOMAIN:-}}"
: "${zone_name:?CLOUDFLARE_ZONE_NAME or APP_DOMAIN is required}"

zone_id="$(resolve_zone_id)"
ttl="${CLOUDFLARE_TTL:-120}"
proxied="${CLOUDFLARE_PROXIED:-false}"
storage_proxied="${CLOUDFLARE_STORAGE_PROXIED:-false}"

if [[ "${storage_proxied}" != "false" ]]; then
  echo "storage.${zone_name} must stay DNS-only for large presigned uploads. Refusing CLOUDFLARE_STORAGE_PROXIED=${storage_proxied}." >&2
  exit 1
fi

for value in "${proxied}" "${storage_proxied}"; do
  case "${value}" in
    true|false) ;;
    *) echo "Cloudflare proxied flags must be true or false, got ${value}" >&2; exit 1 ;;
  esac
done

upsert_a_record "${zone_id}" "${zone_name}" "${zone_name}" "${CLOUDFLARE_RECORD_IP}" "${proxied}" "${ttl}"
upsert_a_record "${zone_id}" "${zone_name}" "www.${zone_name}" "${CLOUDFLARE_RECORD_IP}" "${proxied}" "${ttl}"
upsert_a_record "${zone_id}" "${zone_name}" "api.${zone_name}" "${CLOUDFLARE_RECORD_IP}" "${proxied}" "${ttl}"
upsert_a_record "${zone_id}" "${zone_name}" "grafana.${zone_name}" "${CLOUDFLARE_RECORD_IP}" "${proxied}" "${ttl}"
upsert_a_record "${zone_id}" "${zone_name}" "storage.${zone_name}" "${CLOUDFLARE_RECORD_IP}" "false" "${ttl}"

echo "Cloudflare DNS ready for ${zone_name}"
