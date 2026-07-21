#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/../.."

nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
docker compose -f docker-compose.vps.yml -f docker-compose.gpu.yml exec -T media-worker \
  python3 -c 'import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))'
docker compose -f docker-compose.vps.yml -f docker-compose.gpu.yml exec -T media-worker \
  sh -lc 'ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc'
docker compose -f docker-compose.vps.yml -f docker-compose.gpu.yml exec -T media-worker \
  sh -lc 'test "$MEDIA_ACCELERATOR" = cuda && test "$WHISPERX_DEVICE" = cuda && test -n "$HF_TOKEN"'

echo "GPU, CUDA e NVENC validados."
