#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:${ONE_API_PORT:-3331}}"
WEB_URL="${WEB_URL:-http://localhost:${ONE_WEB_PORT:-3330}}"

echo "[clipbr-one] checking API ready"
curl -fsS "$API_URL/health/ready" | jq .

echo "[clipbr-one] checking pipeline"
curl -fsS "$API_URL/health/pipeline" | jq .

echo "[clipbr-one] checking web"
curl -fsSI "$WEB_URL" | head

echo "[clipbr-one] smoke PASS"
