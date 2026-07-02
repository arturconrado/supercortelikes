#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root on a fresh Ubuntu 24.04 VPS." >&2
  exit 1
fi

APP_USER="${APP_USER:-clipbr}"
APP_ROOT="${APP_ROOT:-/srv/clipbr}"
SSH_PORT="${SSH_PORT:-22}"
SWAP_SIZE="${SWAP_SIZE:-8G}"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg git ufw fail2ban jq openssl lsb-release unattended-upgrades

install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi

cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable
EOF

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if ! id "${APP_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${APP_USER}"
fi
usermod -aG docker "${APP_USER}"

install -d -m 700 -o "${APP_USER}" -g "${APP_USER}" "/home/${APP_USER}/.ssh"
if [[ -n "${DEPLOY_SSH_PUBLIC_KEY:-}" ]]; then
  printf '%s\n' "${DEPLOY_SSH_PUBLIC_KEY}" >> "/home/${APP_USER}/.ssh/authorized_keys"
elif [[ -f /root/.ssh/authorized_keys ]]; then
  cp /root/.ssh/authorized_keys "/home/${APP_USER}/.ssh/authorized_keys"
else
  touch "/home/${APP_USER}/.ssh/authorized_keys"
  echo "WARNING: no SSH public key found for ${APP_USER}. Set DEPLOY_SSH_PUBLIC_KEY or copy an authorized_keys file before GitHub Actions deploy." >&2
fi
chown "${APP_USER}:${APP_USER}" "/home/${APP_USER}/.ssh/authorized_keys"
chmod 600 "/home/${APP_USER}/.ssh/authorized_keys"

install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_ROOT}/app"
install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_ROOT}/backups"
for dir in postgres redis minio media caddy/data caddy/config; do
  install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_ROOT}/data/${dir}"
done
install -d -o 10001 -g 10001 "${APP_ROOT}/data/media/pipelines" "${APP_ROOT}/data/media/models"
chmod -R a+rwX "${APP_ROOT}/data/media"

if [[ ! -f /swapfile ]]; then
  fallocate -l "${SWAP_SIZE}" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

cat >/etc/ssh/sshd_config.d/99-clipbr-hardening.conf <<EOF
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
systemctl reload ssh || systemctl reload sshd || true

ufw allow "${SSH_PORT}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now docker fail2ban unattended-upgrades

echo "VPS provisioned. Copy the repository to ${APP_ROOT}/app and continue with scripts/vps/deploy.sh."
