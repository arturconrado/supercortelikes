#!/usr/bin/env bash
set -euo pipefail

COOKIE_FILE="${1:-}"

if [[ -z "${COOKIE_FILE}" ]]; then
  cat >&2 <<'USAGE'
Usage:
  VPS_HOST=162.243.114.141 ./scripts/vps/configure-youtube-cookies.sh ./youtube-cookies.txt

Optional env:
  VPS_USER=clipbr
  VPS_SSH_PORT=22
  VPS_APP_DIR=/srv/clipbr/app
  COMPOSE_PROJECT_NAME=clipbr-vps
  VPS_COOKIES_PATH=/srv/clipbr/data/media/cookies/youtube.txt
  CONTAINER_COOKIES_PATH=/data/cookies/youtube.txt
  TEST_URL=https://www.youtube.com/watch?v=...

The cookies file must be in Netscape cookies.txt format and is never printed.
USAGE
  exit 2
fi

: "${VPS_HOST:?VPS_HOST is required}"
VPS_USER="${VPS_USER:-clipbr}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_APP_DIR="${VPS_APP_DIR:-/srv/clipbr/app}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clipbr-vps}"
VPS_COOKIES_PATH="${VPS_COOKIES_PATH:-/srv/clipbr/data/media/cookies/youtube.txt}"
CONTAINER_COOKIES_PATH="${CONTAINER_COOKIES_PATH:-/data/cookies/youtube.txt}"

if [[ ! -f "${COOKIE_FILE}" ]]; then
  echo "Cookies file not found: ${COOKIE_FILE}" >&2
  exit 1
fi

if [[ ! -s "${COOKIE_FILE}" ]]; then
  echo "Cookies file is empty: ${COOKIE_FILE}" >&2
  exit 1
fi

if ! awk -F '\t' '
  BEGIN { found = 0 }
  /^[[:space:]]*($|# Netscape HTTP Cookie File)/ { next }
  {
    domain = tolower($1)
    sub(/^#httponly_/, "", domain)
    if (domain == "youtube.com" || domain ~ /\.youtube\.com$/) found = 1
  }
  END { exit(found ? 0 : 1) }
' "${COOKIE_FILE}"; then
  echo "Cookies file does not contain youtube.com cookies in Netscape format." >&2
  echo "Export cookies from a browser session logged into YouTube and try again." >&2
  exit 1
fi

ssh_base=(
  ssh
  -o BatchMode=yes
  -o ConnectTimeout=10
  -p "${VPS_SSH_PORT}"
)
scp_base=(
  scp
  -o BatchMode=yes
  -o ConnectTimeout=10
  -P "${VPS_SSH_PORT}"
)

remote_tmp="/tmp/picashorts-youtube-cookies-${RANDOM}-$(date +%s).txt"
echo "Uploading YouTube cookies to ${VPS_USER}@${VPS_HOST}:${VPS_COOKIES_PATH}"
"${scp_base[@]}" "${COOKIE_FILE}" "${VPS_USER}@${VPS_HOST}:${remote_tmp}"

remote_prefix=$(
  printf 'VPS_APP_DIR=%q VPS_COOKIES_PATH=%q CONTAINER_COOKIES_PATH=%q COMPOSE_PROJECT_NAME=%q REMOTE_TMP=%q TEST_URL=%q' \
    "${VPS_APP_DIR}" \
    "${VPS_COOKIES_PATH}" \
    "${CONTAINER_COOKIES_PATH}" \
    "${COMPOSE_PROJECT_NAME}" \
    "${remote_tmp}" \
    "${TEST_URL:-}"
)

"${ssh_base[@]}" "${VPS_USER}@${VPS_HOST}" "${remote_prefix} bash -s" <<'REMOTE'
set -euo pipefail

cookies_dir="$(dirname "${VPS_COOKIES_PATH}")"
mkdir -p "${cookies_dir}"
install -m 600 "${REMOTE_TMP}" "${VPS_COOKIES_PATH}"
rm -f "${REMOTE_TMP}"

cd "${VPS_APP_DIR}"
if [[ ! -f .env.production ]]; then
  echo ".env.production not found in ${VPS_APP_DIR}" >&2
  exit 1
fi

python3 - .env.production "${CONTAINER_COOKIES_PATH}" <<'PY'
from __future__ import annotations

import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

env_path = Path(sys.argv[1])
container_path = sys.argv[2]
key = "YTDLP_COOKIES_FILE"

stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
backup_path = env_path.with_name(f"{env_path.name}.bak.{stamp}")
shutil.copy2(env_path, backup_path)

lines = env_path.read_text(encoding="utf-8").splitlines()
updated = False
next_lines: list[str] = []
for line in lines:
    if line.startswith(f"{key}="):
        next_lines.append(f"{key}={container_path}")
        updated = True
    else:
        next_lines.append(line)
if not updated:
    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    next_lines.append(f"{key}={container_path}")

env_path.write_text("\n".join(next_lines) + "\n", encoding="utf-8")
print(f"Updated {key}; backup created at {backup_path}")
PY

compose=(
  docker compose
  --env-file .env.production
  -f docker-compose.vps.yml
  -f docker-compose.vps.images.yml
  -p "${COMPOSE_PROJECT_NAME}"
)

"${compose[@]}" up -d --wait media-worker worker

"${compose[@]}" exec -T media-worker python - <<'PY'
from pathlib import Path
from media_worker.config import Settings

settings = Settings.from_env()
cookies_path = Path(settings.ytdlp_cookies_file)
print({
    "cookiesConfigured": bool(settings.ytdlp_cookies_file),
    "cookiesPath": settings.ytdlp_cookies_file,
    "cookiesReadable": cookies_path.is_file() and cookies_path.stat().st_size > 0,
})
PY

if [[ -n "${TEST_URL}" ]]; then
  "${compose[@]}" exec -T media-worker python - "${TEST_URL}" <<'PY'
import os
import sys
import yt_dlp

url = sys.argv[1]
cookiefile = os.environ.get("YTDLP_COOKIES_FILE", "")
opts = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "cookiefile": cookiefile,
}
with yt_dlp.YoutubeDL(opts) as downloader:
    info = downloader.extract_info(url, download=False)
print({
    "youtubeProbe": "ok",
    "title": info.get("title"),
    "duration": info.get("duration"),
})
PY
fi

"${compose[@]}" ps media-worker worker
REMOTE

echo "YouTube cookies configured successfully."
