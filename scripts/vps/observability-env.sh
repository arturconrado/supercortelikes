#!/usr/bin/env bash

random_secret() {
  openssl rand -hex 24
}

append_env_value() {
  local key="$1"
  local value="$2"
  if [[ "${value}" == *"'"* ]]; then
    echo "Refusing to append ${key}: single quotes are not supported in generated env values." >&2
    exit 1
  fi
  printf "%s='%s'\n" "${key}" "${value}" >> "${ENV_FILE}"
  export "${key}=${value}"
}

latest_grafana_credentials_file() {
  ls -1t "${VPS_BACKUP_DIR}"/grafana-credentials-*.txt 2>/dev/null | head -1 || true
}

grafana_credential_value() {
  local file="$1"
  local label="$2"
  [[ -n "${file}" && -f "${file}" ]] || return 0
  awk -F': ' -v label="${label}" '$1 == label { print substr($0, index($0, $2)); exit }' "${file}"
}

hash_caddy_password() {
  local password="$1"
  docker run --rm caddy:2.10-alpine caddy hash-password --plaintext "${password}"
}

ensure_observability_env() {
  : "${APP_DOMAIN:?APP_DOMAIN is required before ensure_observability_env}"
  : "${VPS_BACKUP_DIR:?VPS_BACKUP_DIR is required before ensure_observability_env}"
  mkdir -p "${VPS_BACKUP_DIR}"

  local latest_credentials
  latest_credentials="$(latest_grafana_credentials_file)"

  local generated_credentials_file=""
  local grafana_admin_user="${GRAFANA_ADMIN_USER:-admin}"
  local grafana_admin_password="${GRAFANA_ADMIN_PASSWORD:-}"
  local grafana_basic_auth_user="${GRAFANA_BASIC_AUTH_USER:-admin}"
  local grafana_basic_auth_password="${GRAFANA_BASIC_AUTH_PASSWORD:-}"
  local grafana_basic_auth_password_hash="${GRAFANA_BASIC_AUTH_PASSWORD_HASH:-}"

  if [[ -z "${GRAFANA_PUBLIC_URL:-}" ]]; then
    append_env_value GRAFANA_PUBLIC_URL "https://grafana.${APP_DOMAIN}"
  fi

  if [[ -z "${GRAFANA_ADMIN_USER:-}" ]]; then
    append_env_value GRAFANA_ADMIN_USER "${grafana_admin_user}"
  fi

  if [[ -z "${grafana_admin_password}" ]]; then
    grafana_admin_password="$(grafana_credential_value "${latest_credentials}" "Grafana admin password")"
    if [[ -z "${grafana_admin_password}" ]]; then
      grafana_admin_password="$(random_secret)"
      generated_credentials_file="${VPS_BACKUP_DIR}/grafana-credentials-$(date +%Y%m%d%H%M%S).txt"
    fi
    append_env_value GRAFANA_ADMIN_PASSWORD "${grafana_admin_password}"
  fi

  if [[ -z "${GRAFANA_BASIC_AUTH_USER:-}" ]]; then
    append_env_value GRAFANA_BASIC_AUTH_USER "${grafana_basic_auth_user}"
  fi

  if [[ -z "${grafana_basic_auth_password_hash}" ]]; then
    if [[ -z "${grafana_basic_auth_password}" ]]; then
      grafana_basic_auth_password="$(grafana_credential_value "${latest_credentials}" "Basic Auth password")"
    fi
    if [[ -z "${grafana_basic_auth_password}" ]]; then
      grafana_basic_auth_password="$(random_secret)"
      generated_credentials_file="${VPS_BACKUP_DIR}/grafana-credentials-$(date +%Y%m%d%H%M%S).txt"
    fi
    grafana_basic_auth_password_hash="$(hash_caddy_password "${grafana_basic_auth_password}")"
    append_env_value GRAFANA_BASIC_AUTH_PASSWORD_HASH "${grafana_basic_auth_password_hash}"
  fi

  if [[ -n "${generated_credentials_file}" ]]; then
    {
      printf 'Grafana URL: https://grafana.%s\n' "${APP_DOMAIN}"
      printf 'Basic Auth user: %s\n' "${grafana_basic_auth_user}"
      printf 'Basic Auth password: %s\n' "${grafana_basic_auth_password}"
      printf 'Grafana admin user: %s\n' "${grafana_admin_user}"
      printf 'Grafana admin password: %s\n' "${grafana_admin_password}"
    } > "${generated_credentials_file}"
    chmod 600 "${generated_credentials_file}"
    echo "Generated missing Grafana credentials and stored them in ${generated_credentials_file}"
  elif [[ -n "${latest_credentials}" ]]; then
    echo "Reused existing Grafana credentials from ${latest_credentials}"
  fi
}
