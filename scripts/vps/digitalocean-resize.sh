#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

do_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local url="https://api.digitalocean.com/v2${path}"

  if [[ -n "${data}" ]]; then
    curl -fsS -X "${method}" "${url}" \
      -H "Authorization: Bearer ${DIGITALOCEAN_ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "${data}"
  else
    curl -fsS -X "${method}" "${url}" \
      -H "Authorization: Bearer ${DIGITALOCEAN_ACCESS_TOKEN}" \
      -H "Content-Type: application/json"
  fi
}

wait_action() {
  local action_id="$1"
  local description="$2"

  for attempt in $(seq 1 180); do
    action_json="$(do_api GET "/actions/${action_id}")"
    status="$(jq -r '.action.status' <<< "${action_json}")"
    case "${status}" in
      completed)
        echo "DigitalOcean action completed: ${description}"
        return 0
        ;;
      errored)
        echo "DigitalOcean action errored: ${description}" >&2
        jq '.action' <<< "${action_json}" >&2
        return 1
        ;;
      in-progress)
        echo "Waiting for ${description}... attempt ${attempt}/180"
        sleep 5
        ;;
      *)
        echo "Unexpected DigitalOcean action status for ${description}: ${status}" >&2
        jq '.action' <<< "${action_json}" >&2
        return 1
        ;;
    esac
  done

  echo "Timed out waiting for DigitalOcean action: ${description}" >&2
  return 1
}

run_action() {
  local type="$1"
  local description="$2"
  local extra="${3:-}"
  local body

  if [[ -n "${extra}" ]]; then
    body="{\"type\":\"${type}\",${extra}}"
  else
    body="{\"type\":\"${type}\"}"
  fi

  action_json="$(do_api POST "/droplets/${DIGITALOCEAN_DROPLET_ID}/actions" "${body}")"
  action_id="$(jq -r '.action.id' <<< "${action_json}")"
  if [[ -z "${action_id}" || "${action_id}" == "null" ]]; then
    echo "DigitalOcean did not return an action id for ${description}." >&2
    jq . <<< "${action_json}" >&2
    return 1
  fi
  wait_action "${action_id}" "${description}"
}

wait_droplet_status() {
  local expected="$1"
  for attempt in $(seq 1 120); do
    droplet_json="$(do_api GET "/droplets/${DIGITALOCEAN_DROPLET_ID}")"
    status="$(jq -r '.droplet.status' <<< "${droplet_json}")"
    if [[ "${status}" == "${expected}" ]]; then
      echo "Droplet status is ${expected}"
      return 0
    fi
    echo "Waiting for Droplet status ${expected}; current=${status}; attempt ${attempt}/120"
    sleep 5
  done
  echo "Timed out waiting for Droplet status ${expected}" >&2
  return 1
}

require_cmd curl
require_cmd jq

: "${DIGITALOCEAN_ACCESS_TOKEN:?DIGITALOCEAN_ACCESS_TOKEN is required}"
: "${DIGITALOCEAN_DROPLET_ID:?DIGITALOCEAN_DROPLET_ID is required}"
: "${DIGITALOCEAN_DROPLET_SIZE:?DIGITALOCEAN_DROPLET_SIZE is required}"
: "${DIGITALOCEAN_RESIZE_DISK:=true}"

droplet_json="$(do_api GET "/droplets/${DIGITALOCEAN_DROPLET_ID}")"
current_size="$(jq -r '.droplet.size_slug' <<< "${droplet_json}")"
current_status="$(jq -r '.droplet.status' <<< "${droplet_json}")"
droplet_ip="$(jq -r '.droplet.networks.v4[]? | select(.type == "public") | .ip_address' <<< "${droplet_json}" | head -n 1)"

echo "DigitalOcean Droplet resize check: id=${DIGITALOCEAN_DROPLET_ID} ip=${droplet_ip} current=${current_size} target=${DIGITALOCEAN_DROPLET_SIZE} status=${current_status}"

if [[ "${current_size}" == "${DIGITALOCEAN_DROPLET_SIZE}" ]]; then
  echo "DigitalOcean Droplet already has target size ${DIGITALOCEAN_DROPLET_SIZE}."
  exit 0
fi

if [[ "${current_status}" == "active" ]]; then
  echo "Shutting down Droplet before resize..."
  if ! run_action shutdown shutdown; then
    echo "Graceful shutdown failed; trying power_off." >&2
    run_action power_off power_off
  fi
  wait_droplet_status off
fi

echo "Resizing Droplet to ${DIGITALOCEAN_DROPLET_SIZE} with disk=${DIGITALOCEAN_RESIZE_DISK}..."
run_action resize resize "\"size\":\"${DIGITALOCEAN_DROPLET_SIZE}\",\"disk\":${DIGITALOCEAN_RESIZE_DISK}"

echo "Powering Droplet on..."
run_action power_on power_on
wait_droplet_status active

echo "DigitalOcean resize finished."
