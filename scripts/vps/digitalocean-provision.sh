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

doctl_json() {
  doctl "$@" --output json
}

find_droplet_by_name() {
  local name="$1"
  doctl_json compute droplet list | jq --arg name "${name}" '[.[] | select(.name == $name)]'
}

find_firewall_by_name() {
  local name="$1"
  doctl_json compute firewall list | jq --arg name "${name}" '[.[] | select(.name == $name)]'
}

public_ipv4() {
  jq -r '.networks.v4[]? | select(.type == "public") | .ip_address' | head -n 1
}

upsert_a_record() {
  local domain="$1"
  local record_name="$2"
  local ip="$3"

  local records
  local record_id
  records="$(doctl_json compute domain records list "${domain}")"
  record_id="$(jq -r --arg name "${record_name}" '.[] | select(.type == "A" and .name == $name) | .id' <<< "${records}" | head -n 1)"

  if [[ -n "${record_id}" && "${record_id}" != "null" ]]; then
    doctl compute domain records update "${domain}" \
      --record-id "${record_id}" \
      --record-type A \
      --record-name "${record_name}" \
      --record-data "${ip}" >/dev/null
    echo "Updated A record ${record_name} -> ${ip}"
  else
    doctl compute domain records create "${domain}" \
      --record-type A \
      --record-name "${record_name}" \
      --record-data "${ip}" >/dev/null
    echo "Created A record ${record_name} -> ${ip}"
  fi
}

require_cmd doctl
require_cmd jq

: "${DIGITALOCEAN_DROPLET_NAME:=clipbr-vps}"
: "${DIGITALOCEAN_DROPLET_REGION:=nyc3}"
: "${DIGITALOCEAN_DROPLET_IMAGE:=ubuntu-24-04-x64}"
: "${DIGITALOCEAN_DROPLET_SIZE:=s-4vcpu-8gb}"
: "${DIGITALOCEAN_TAG:=clipbr}"
: "${DIGITALOCEAN_FIREWALL_NAME:=clipbr-vps-firewall}"
: "${DIGITALOCEAN_MANAGE_DNS:=false}"

if ! doctl compute tag get "${DIGITALOCEAN_TAG}" >/dev/null 2>&1; then
  doctl compute tag create "${DIGITALOCEAN_TAG}" >/dev/null
  echo "Created DigitalOcean tag ${DIGITALOCEAN_TAG}"
fi

droplet_matches="$(find_droplet_by_name "${DIGITALOCEAN_DROPLET_NAME}")"
droplet_count="$(jq 'length' <<< "${droplet_matches}")"

if [[ "${droplet_count}" == "0" ]]; then
  : "${DIGITALOCEAN_SSH_KEY_IDS:?DIGITALOCEAN_SSH_KEY_IDS is required when creating a new Droplet}"
  echo "Creating Droplet ${DIGITALOCEAN_DROPLET_NAME} in ${DIGITALOCEAN_DROPLET_REGION} (${DIGITALOCEAN_DROPLET_SIZE})..."
  doctl compute droplet create "${DIGITALOCEAN_DROPLET_NAME}" \
    --region "${DIGITALOCEAN_DROPLET_REGION}" \
    --image "${DIGITALOCEAN_DROPLET_IMAGE}" \
    --size "${DIGITALOCEAN_DROPLET_SIZE}" \
    --ssh-keys "${DIGITALOCEAN_SSH_KEY_IDS}" \
    --tag-names "${DIGITALOCEAN_TAG}" \
    --enable-monitoring \
    --wait >/dev/null
  droplet_matches="$(find_droplet_by_name "${DIGITALOCEAN_DROPLET_NAME}")"
  droplet_count="$(jq 'length' <<< "${droplet_matches}")"
elif [[ "${droplet_count}" == "1" ]]; then
  echo "Reusing existing Droplet ${DIGITALOCEAN_DROPLET_NAME}"
else
  echo "Expected at most one Droplet named ${DIGITALOCEAN_DROPLET_NAME}, found ${droplet_count}." >&2
  jq -r '.[] | "\(.id)\t\(.name)\t\(.status)"' <<< "${droplet_matches}" >&2
  exit 1
fi

if [[ "${droplet_count}" != "1" ]]; then
  echo "Droplet provisioning did not result in exactly one Droplet." >&2
  exit 1
fi

droplet="$(jq '.[0]' <<< "${droplet_matches}")"
droplet_id="$(jq -r '.id' <<< "${droplet}")"
droplet_status="$(jq -r '.status' <<< "${droplet}")"
droplet_ip="$(jq -r '.networks.v4[]? | select(.type == "public") | .ip_address' <<< "${droplet}" | head -n 1)"

if [[ "${droplet_status}" != "active" ]]; then
  echo "Droplet ${droplet_id} is not active after provisioning: ${droplet_status}" >&2
  exit 1
fi

if [[ -z "${droplet_ip}" || "${droplet_ip}" == "null" ]]; then
  echo "Droplet ${droplet_id} has no public IPv4 address." >&2
  exit 1
fi

inbound_rules="protocol:tcp,ports:22,address:0.0.0.0/0 protocol:tcp,ports:80,address:0.0.0.0/0 protocol:tcp,ports:443,address:0.0.0.0/0"
outbound_rules="protocol:icmp,address:0.0.0.0/0 protocol:tcp,ports:all,address:0.0.0.0/0 protocol:udp,ports:all,address:0.0.0.0/0"

firewall_matches="$(find_firewall_by_name "${DIGITALOCEAN_FIREWALL_NAME}")"
firewall_count="$(jq 'length' <<< "${firewall_matches}")"

if [[ "${firewall_count}" == "0" ]]; then
  echo "Creating firewall ${DIGITALOCEAN_FIREWALL_NAME}..."
  doctl compute firewall create \
    --name "${DIGITALOCEAN_FIREWALL_NAME}" \
    --droplet-ids "${droplet_id}" \
    --tag-names "${DIGITALOCEAN_TAG}" \
    --inbound-rules "${inbound_rules}" \
    --outbound-rules "${outbound_rules}" >/dev/null
  firewall_matches="$(find_firewall_by_name "${DIGITALOCEAN_FIREWALL_NAME}")"
  firewall_count="$(jq 'length' <<< "${firewall_matches}")"
elif [[ "${firewall_count}" == "1" ]]; then
  echo "Updating existing firewall ${DIGITALOCEAN_FIREWALL_NAME}"
else
  echo "Expected at most one firewall named ${DIGITALOCEAN_FIREWALL_NAME}, found ${firewall_count}." >&2
  exit 1
fi

if [[ "${firewall_count}" != "1" ]]; then
  echo "Firewall provisioning did not result in exactly one firewall." >&2
  exit 1
fi

firewall_id="$(jq -r '.[0].id' <<< "${firewall_matches}")"

doctl compute firewall update "${firewall_id}" \
  --name "${DIGITALOCEAN_FIREWALL_NAME}" \
  --droplet-ids "${droplet_id}" \
  --inbound-rules "${inbound_rules}" \
  --outbound-rules "${outbound_rules}" >/dev/null

if [[ "${DIGITALOCEAN_MANAGE_DNS}" == "true" ]]; then
  : "${DIGITALOCEAN_DOMAIN:?DIGITALOCEAN_DOMAIN is required when DIGITALOCEAN_MANAGE_DNS=true}"

  if ! doctl compute domain list --output json | jq -e --arg domain "${DIGITALOCEAN_DOMAIN}" 'any(.[]; .name == $domain)' >/dev/null; then
    doctl compute domain create "${DIGITALOCEAN_DOMAIN}" --ip-address "${droplet_ip}" >/dev/null
    echo "Created DigitalOcean domain ${DIGITALOCEAN_DOMAIN}"
  fi

  upsert_a_record "${DIGITALOCEAN_DOMAIN}" "@" "${droplet_ip}"
  upsert_a_record "${DIGITALOCEAN_DOMAIN}" "api" "${droplet_ip}"
  upsert_a_record "${DIGITALOCEAN_DOMAIN}" "grafana" "${droplet_ip}"
  upsert_a_record "${DIGITALOCEAN_DOMAIN}" "storage" "${droplet_ip}"
fi

emit_output droplet_id "${droplet_id}"
emit_output droplet_ip "${droplet_ip}"
emit_output firewall_id "${firewall_id}"

echo "DigitalOcean provisioning OK: droplet=${DIGITALOCEAN_DROPLET_NAME} id=${droplet_id} ip=${droplet_ip} firewall=${firewall_id}"
