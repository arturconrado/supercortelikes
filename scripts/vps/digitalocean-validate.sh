#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

emit_output() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "${key}" "${value}" >> "${GITHUB_OUTPUT}"
  fi
}

is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

droplet_json_by_id() {
  local id="$1"
  doctl compute droplet get "${id}" --output json
}

droplet_json_by_name() {
  local name="$1"
  doctl compute droplet list --output json | jq --arg name "${name}" '[.[] | select(.name == $name)]'
}

droplet_json_by_public_ip() {
  local ip="$1"
  doctl compute droplet list --output json | jq --arg ip "${ip}" '[.[] | select(any(.networks.v4[]?; .type == "public" and .ip_address == $ip))]'
}

resolve_ipv4() {
  local host="$1"
  if is_ipv4 "${host}"; then
    printf '%s\n' "${host}"
    return 0
  fi
  if command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "${host}" | awk '{ print $1; exit }'
    return 0
  fi
  return 1
}

public_ipv4_from_droplet() {
  jq -r '.networks.v4[]? | select(.type == "public") | .ip_address' | head -n 1
}

firewall_json_by_name() {
  local name="$1"
  doctl compute firewall list --output json | jq --arg name "${name}" '[.[] | select(.name == $name)]'
}

dns_record_exists() {
  local records_json="$1"
  local name="$2"
  local ip="$3"

  jq -e --arg name "${name}" --arg ip "${ip}" '
    any(.[]; .type == "A" and .name == $name and .data == $ip)
  ' <<< "${records_json}" >/dev/null
}

require_cmd doctl
require_cmd jq

: "${DIGITALOCEAN_DROPLET_NAME:=}"
: "${DIGITALOCEAN_FIREWALL_NAME:=}"
: "${DIGITALOCEAN_MANAGE_DNS:=false}"

droplet_json=""
match_count=0

if [[ -n "${DIGITALOCEAN_DROPLET_ID:-}" ]]; then
  droplet_json="$(droplet_json_by_id "${DIGITALOCEAN_DROPLET_ID}")"
  match_count="$(jq 'length' <<< "${droplet_json}")"
elif [[ -n "${DIGITALOCEAN_DROPLET_NAME:-}" ]]; then
  droplet_json="$(droplet_json_by_name "${DIGITALOCEAN_DROPLET_NAME}")"
  match_count="$(jq 'length' <<< "${droplet_json}")"
elif [[ -n "${VPS_HOST:-}" ]]; then
  resolved_vps_host="$(resolve_ipv4 "${VPS_HOST}" || true)"
  if [[ -n "${resolved_vps_host}" ]]; then
    droplet_json="$(droplet_json_by_public_ip "${resolved_vps_host}")"
    match_count="$(jq 'length' <<< "${droplet_json}")"
  fi
fi

if [[ "${match_count}" == "0" ]]; then
  echo "DigitalOcean Droplet not found. Set DIGITALOCEAN_DROPLET_ID, DIGITALOCEAN_DROPLET_NAME, or VPS_HOST pointing to the existing Droplet." >&2
  exit 1
fi

if [[ "${match_count}" != "1" ]]; then
  echo "Expected exactly one DigitalOcean Droplet match, found ${match_count}." >&2
  jq -r '.[] | "\(.id)\t\(.name)\t\(.status)"' <<< "${droplet_json}" >&2
  exit 1
fi

droplet="$(jq '.[0]' <<< "${droplet_json}")"
droplet_id="$(jq -r '.id' <<< "${droplet}")"
droplet_name="$(jq -r '.name' <<< "${droplet}")"
droplet_status="$(jq -r '.status' <<< "${droplet}")"
droplet_region="$(jq -r '.region.slug // empty' <<< "${droplet}")"
droplet_size="$(jq -r '.size_slug // empty' <<< "${droplet}")"
droplet_ip="$(jq -r '.networks.v4[]? | select(.type == "public") | .ip_address' <<< "${droplet}" | head -n 1)"

if [[ -z "${droplet_ip}" || "${droplet_ip}" == "null" ]]; then
  echo "Droplet ${droplet_id} has no public IPv4 address yet." >&2
  exit 1
fi

if [[ "${droplet_status}" != "active" ]]; then
  echo "Droplet ${droplet_id} is not active: ${droplet_status}" >&2
  exit 1
fi

if [[ -n "${VPS_HOST:-}" ]]; then
  resolved_vps_host="$(resolve_ipv4 "${VPS_HOST}" || true)"
  if [[ -n "${resolved_vps_host}" && "${resolved_vps_host}" != "${droplet_ip}" ]]; then
    echo "VPS_HOST=${VPS_HOST} resolves to ${resolved_vps_host}, but Droplet public IP is ${droplet_ip}." >&2
    exit 1
  fi
fi

firewall_id=""
if [[ -n "${DIGITALOCEAN_FIREWALL_NAME}" ]]; then
  firewall_matches="$(firewall_json_by_name "${DIGITALOCEAN_FIREWALL_NAME}")"
  firewall_count="$(jq 'length' <<< "${firewall_matches}")"
  if [[ "${firewall_count}" == "0" ]]; then
    echo "DigitalOcean firewall not found: ${DIGITALOCEAN_FIREWALL_NAME}" >&2
    exit 1
  fi
  if [[ "${firewall_count}" != "1" ]]; then
    echo "Expected one firewall named ${DIGITALOCEAN_FIREWALL_NAME}, found ${firewall_count}." >&2
    exit 1
  fi

  firewall_id="$(jq -r '.[0].id' <<< "${firewall_matches}")"
  firewall="$(doctl compute firewall get "${firewall_id}" --output json | jq '.[0]')"

  attached="$(
    jq -e --argjson droplet_id "${droplet_id}" --arg tag "${DIGITALOCEAN_TAG:-clipbr}" '
      ((.droplet_ids // []) | index($droplet_id)) != null
      or
      ((.tags // .tag_names // []) | index($tag)) != null
    ' <<< "${firewall}" >/dev/null && echo true || echo false
  )"

  if [[ "${attached}" != "true" ]]; then
    echo "Firewall ${DIGITALOCEAN_FIREWALL_NAME} is not attached to Droplet ${droplet_id} and does not target tag ${DIGITALOCEAN_TAG:-clipbr}." >&2
    exit 1
  fi

  for port in 22 80 443; do
    if ! jq -e --arg port "${port}" '
      any(.inbound_rules[]?;
        .protocol == "tcp"
        and (.ports | tostring) == $port
        and any((.sources.addresses // []); . == "0.0.0.0/0")
      )
    ' <<< "${firewall}" >/dev/null; then
      echo "Firewall ${DIGITALOCEAN_FIREWALL_NAME} is missing inbound TCP ${port} from 0.0.0.0/0." >&2
      exit 1
    fi
  done
else
  echo "WARN: DIGITALOCEAN_FIREWALL_NAME is not set; skipping DigitalOcean Cloud Firewall validation." >&2
fi

if [[ "${DIGITALOCEAN_MANAGE_DNS}" == "true" ]]; then
  : "${DIGITALOCEAN_DOMAIN:?DIGITALOCEAN_DOMAIN is required when DIGITALOCEAN_MANAGE_DNS=true}"

  if ! doctl compute domain list --output json | jq -e --arg domain "${DIGITALOCEAN_DOMAIN}" 'any(.[]; .name == $domain)' >/dev/null; then
    echo "DigitalOcean domain not found: ${DIGITALOCEAN_DOMAIN}" >&2
    exit 1
  fi

  records_json="$(doctl compute domain records list "${DIGITALOCEAN_DOMAIN}" --output json)"
  dns_record_exists "${records_json}" "@" "${droplet_ip}" || {
    echo "Missing A record ${DIGITALOCEAN_DOMAIN} -> ${droplet_ip}." >&2
    exit 1
  }
  dns_record_exists "${records_json}" "api" "${droplet_ip}" || {
    echo "Missing A record api.${DIGITALOCEAN_DOMAIN} -> ${droplet_ip}." >&2
    exit 1
  }
  dns_record_exists "${records_json}" "grafana" "${droplet_ip}" || {
    echo "Missing A record grafana.${DIGITALOCEAN_DOMAIN} -> ${droplet_ip}." >&2
    exit 1
  }
  dns_record_exists "${records_json}" "storage" "${droplet_ip}" || {
    echo "Missing A record storage.${DIGITALOCEAN_DOMAIN} -> ${droplet_ip}." >&2
    exit 1
  }
fi

emit_output droplet_id "${droplet_id}"
emit_output droplet_ip "${droplet_ip}"
emit_output droplet_name "${droplet_name}"
emit_output droplet_region "${droplet_region}"
emit_output droplet_size "${droplet_size}"
[[ -n "${firewall_id}" ]] && emit_output firewall_id "${firewall_id}"

echo "DigitalOcean validation OK: droplet=${droplet_name} id=${droplet_id} ip=${droplet_ip} region=${droplet_region} size=${droplet_size} firewall=${firewall_id}"
