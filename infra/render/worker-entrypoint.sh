#!/bin/sh
set -eu

export RETAIN_SOURCE_DOWNLOADS="${RETAIN_SOURCE_DOWNLOADS:-false}"

media_pid=''
node_pid=''

shutdown() {
  [ -z "$node_pid" ] || kill -TERM "$node_pid" 2>/dev/null || true
  [ -z "$media_pid" ] || kill -TERM "$media_pid" 2>/dev/null || true
  [ -z "$node_pid" ] || wait "$node_pid" 2>/dev/null || true
  [ -z "$media_pid" ] || wait "$media_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

mkdir -p /data/models /data/pipelines
find /data/pipelines -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf -- {} + 2>/dev/null || true

uvicorn media_worker.app:app --host 127.0.0.1 --port 8090 &
media_pid=$!

attempt=0
until python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health/ready', timeout=8)" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ] || ! kill -0 "$media_pid" 2>/dev/null; then
    echo '{"level":"error","service":"worker-bundle","message":"media worker failed readiness"}' >&2
    exit 1
  fi
  sleep 5
done

node apps/api/dist/worker.js &
node_pid=$!

failures=0
cleanup_ticks=0
while kill -0 "$media_pid" 2>/dev/null && kill -0 "$node_pid" 2>/dev/null; do
  sleep 15
  cleanup_ticks=$((cleanup_ticks + 1))
  if [ "$cleanup_ticks" -ge 240 ]; then
    find /data/pipelines -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf -- {} + 2>/dev/null || true
    cleanup_ticks=0
  fi
  if node apps/api/dist/worker-health.js >/dev/null 2>&1; then
    failures=0
  else
    failures=$((failures + 1))
    if [ "$failures" -ge 3 ]; then
      echo '{"level":"error","service":"worker-bundle","message":"worker watchdog failed"}' >&2
      exit 1
    fi
  fi
done

echo '{"level":"error","service":"worker-bundle","message":"a bundled process exited"}' >&2
exit 1
