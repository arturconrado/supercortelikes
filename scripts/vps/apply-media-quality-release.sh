#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.production}"
RELEASE_KEY="MEDIA_QUALITY_RELEASE"
RELEASE_VALUE="active-speaker-v1"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing production environment file: ${ENV_FILE}" >&2
  exit 1
fi

current_release="$(
  awk -F= -v key="${RELEASE_KEY}" '$1 == key { value = substr($0, index($0, "=") + 1) } END { print value }' "${ENV_FILE}"
)"

if [[ "${current_release}" == "${RELEASE_VALUE}" ]]; then
  echo "Media quality release configuration already applied."
  exit 0
fi

upsert_env() {
  local key="$1"
  local value="$2"
  local temporary

  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      if (!replaced) {
        print key "=" value
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (!replaced) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${temporary}"
  chmod 600 "${temporary}"
  mv "${temporary}" "${ENV_FILE}"
}

upsert_env "COMPOSITION_V1_ENABLED" "true"
upsert_env "COMPOSITION_V1_ROLLOUT_PERCENT" "100"
upsert_env "OPENROUTER_QA_ENABLED" "true"
upsert_env "OPENROUTER_VIDEO_ENABLED" "true"
upsert_env "OPENROUTER_VIDEO_MODEL" "google/gemini-3-flash-preview"
upsert_env "OPENROUTER_VIDEO_MAX_BYTES" "20971520"
upsert_env "OPENROUTER_VIDEO_TIMEOUT_SECONDS" "90"
upsert_env "OPENROUTER_VIDEO_RETRIES" "3"
upsert_env "${RELEASE_KEY}" "${RELEASE_VALUE}"

echo "Applied media quality release configuration ${RELEASE_VALUE}."
