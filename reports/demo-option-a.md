# Relatório — Demo Cloud Automatizada (Opção A)

Data: 2026-06-25  
Estado: **REPO-READY — GO-LIVE PENDENTE DE CREDENCIAIS EXTERNAS E SMOKE EXTERNO**

## Entrega

- Runtime fail-fast para `release|production`, aliases de rollout e HMAC independente para refresh tokens.
- Readiness da API cobre banco, Redis, R2, relay de outbox e registro das oito filas.
- Upload multipart R2 com partes de 64 MiB, URLs de 15 minutos, idempotência, ownership, confirmação por `HeadObject`, abort e exclusão encadeada de objetos.
- Cliente web com validação prévia, duas partes concorrentes, retry exponencial, retomada em `sessionStorage`, progresso e cancelamento remoto.
- Imagem Render bundle Debian: Node 22 + Python 3.11 + FFmpeg/FFprobe + WhisperX/OpenCV/MediaPipe/Ultralytics + watchdog. Media HTTP fica em `127.0.0.1:8090`; carga pesada é serial.
- Manifestos locais, externos, Render, Vercel e GitHub Actions com promoção exclusiva do SHA aprovado.
- Script de CORS/lifecycle do R2, regressão multipart 5 GiB, smoke externo e espera dos dois deploys Render.
- Cache de modelos e artefatos em `/data`, com limpeza agressiva de memória nativa após estágios de IA/render para manter o worker serial dentro do envelope da demo.

## Causa arquitetural tratada

Background workers Render não expõem HTTP e discos persistentes não são compartilhados entre serviços. Node/BullMQ e Python/IA foram reunidos no mesmo serviço e volume. O navegador envia o vídeo diretamente ao R2, removendo a API do caminho de dados de até 5 GiB.

No gate local, o media-worker chegou a concluir o E2E mas morrer por OOM depois do processamento. A correção aplicada evita carregar detectores mais pesados no caminho padrão de render, fecha detectores nativos, reaproveita `/data` para caches e executa limpeza de arenas nativas/PyTorch após cada estágio pesado.

## Validações locais executadas

| Verificação | Resultado |
|---|---:|
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS — API 52 testes; Web 14 testes |
| `npm run test:coverage` | PASS — API statements 78,68%; branches 61,45%; functions 80,93%; lines 82,61% |
| Media worker pytest | PASS — 30 testes |
| Worker coverage | PASS — statements/lines 75,33%; branches 61,46%; functions 79,00% |
| `npm run build` | PASS |
| `npm run db:validate` | PASS |
| Compose `local-lite`/`local-full` | PASS (`config --quiet`) |
| Compose release externo com variáveis sintéticas | PASS (`config`) |
| GitHub Actions/actionlint | PASS |
| Render worker bundle | PASS — Node/Python/FFmpeg/IA sob limite de 2 GB |
| E2E `local-full` | PASS — upload direto, oito estágios, export, download e `ffprobe` |
| Regressão multipart 5 GiB | PASS — 80 partes, sem tráfego do corpo pela API |
| Estabilidade pós-E2E | PASS — API, worker, media-worker, PostgreSQL, Redis e MinIO por 10+ minutos sem restart/OOM |

O workflow aplica cobertura mínima de 60% separadamente a TypeScript e Python, migration a partir de banco vazio, quatro builds de imagem e E2E real com PostgreSQL, Redis, MinIO, IA e estabilidade de dez minutos.

Comandos centrais executados nesta auditoria:

```bash
npm run lint && npm run typecheck
npm test && npm run test:coverage && npm run build && npm run db:validate
PYTHONPATH=services/media-worker/src services/media-worker/.venv/bin/python -m pytest services/media-worker/tests --cov=media_worker --cov-branch --cov-report=json:/tmp/media-option-a.json
services/media-worker/.venv/bin/python services/media-worker/scripts/check_coverage.py /tmp/media-option-a.json 60
docker compose -f docker-compose.local.yml --profile local-lite config --quiet
docker compose -f docker-compose.local.yml --profile local-full config --quiet
docker compose -f docker-compose.release.yml config --quiet
docker build -f infra/render/worker.Dockerfile -t clipbr-worker-bundle:option-a .
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7
PORT=53101 WEB_PORT=53100 POSTGRES_PORT=55433 REDIS_PORT=56380 MINIO_API_PORT=59002 MINIO_CONSOLE_PORT=59003 S3_PUBLIC_ENDPOINT=http://localhost:59002 PUBLIC_API_URL=http://localhost:53101 PUBLIC_APP_URL=http://localhost:53100 CORS_ORIGIN=http://localhost:53100 NEXT_PUBLIC_API_URL=http://localhost:53101 docker compose -f docker-compose.local.yml -p clipbr-option-a-gate --profile local-full up --build --detach --wait
DATABASE_URL='postgresql://clipbr_local:clipbr_local_9Tq4xV7mK2pR8sW6@localhost:55433/clipbr?schema=public' ACCEPTANCE_API_URL=http://127.0.0.1:53101 ACCEPTANCE_UPLOAD_MODE=direct ACCEPTANCE_VIDEO_PATH=/tmp/clipbr-option-a.mp4 ACCEPTANCE_COMPOSE_FILE=docker-compose.local.yml ACCEPTANCE_MEDIA_PROFILE=local-full COMPOSE_PROJECT_NAME=clipbr-option-a-gate node scripts/acceptance/release-recovery.mjs
PORT=53201 WEB_PORT=53200 POSTGRES_PORT=55434 REDIS_PORT=56381 MINIO_API_PORT=59004 MINIO_CONSOLE_PORT=59005 S3_PUBLIC_ENDPOINT=http://localhost:59004 PUBLIC_API_URL=http://localhost:53201 PUBLIC_APP_URL=http://localhost:53200 CORS_ORIGIN=http://localhost:53200 NEXT_PUBLIC_API_URL=http://localhost:53201 docker compose -f docker-compose.local.yml -p clipbr-five-gib-gate --profile local-lite up --build --detach --wait
ACCEPTANCE_API_URL=http://127.0.0.1:53201 node scripts/acceptance/direct-upload-5g.mjs
```

Snapshot local de readiness:

```json
{"status":"ok","build":"development","database":"up","redis":"up","storage":"up","outboxRelay":"up","queues":"registered","configuration":"valid"}
```

Snapshot media-worker:

```json
{"status":"ready","required":["ffmpeg","ffprobe","storage","redis","whisperx","opencv","mediapipe","yolo"],"dependencies":{"ffmpeg":true,"ffprobe":true,"whisperx":true,"opencv":true,"mediapipe":true,"yolo":true,"storage":true,"redis":true,"huggingFaceToken":false}}
```

Resultado E2E local-full:

```text
account: release-1b5eb115@clipbr.test
projectId: 608e97a9-07a0-4a97-b218-1b909dfe62d6
videoId: fc576844-84e8-42b4-b7a2-d3df3c8c0d75
pipelineRunId: 56ec364c-49bc-433c-94e6-288d8716c8e4
stages: INGESTION, TRANSCRIPTION, SEGMENTATION, SCORING, CLIPS, CAPTIONS, RENDERING, EXPORTS = SUCCEEDED, attempts=1
transcriptCharacters: 115
segments: 1
scores: 1
clips: 1
exportId: 9f6b178f-6e18-4fe7-987c-71e98c630e75
downloadStatus: 200
ffprobe: h264, 1080x1920
DLQ aberta: 0
outbox pendente: 0
```

Resultado 5 GiB:

```text
videoId: e95aa7f5-3c16-4fc8-a0f7-fae6adacfa32
sizeBytes: 5368709120
parts: 80
status: PASS
```

Snapshot de estabilidade pós-E2E:

```text
api, media-worker, worker, postgres, redis, minio: healthy/running, RestartCount=0, OOMKilled=false
web: healthy/running após healthcheck local adicionado, RestartCount=0, OOMKilled=false
media-worker memory: ~771 MiB / 3.827 GiB no Docker Desktop local
```

URLs live serão registradas após provisionamento: `RENDER_API_URL` e `VERCEL_APP_URL`. Nenhuma URL pública foi inventada neste relatório.

## Arquivos principais

- Runtime: `apps/api/src/config/env.ts`, `apps/api/src/health/health.controller.ts`, `services/media-worker/src/media_worker/config.py`, `services/media-worker/src/media_worker/app.py`.
- Multipart: migration `20260622030000_direct_multipart_upload`, `direct-upload.service.ts`, `direct-upload.dto.ts`, storage R2 e `apps/web/lib/upload.ts`.
- Infra: `infra/render/worker.Dockerfile`, `worker-entrypoint.sh`, `docker-compose.local.yml`, `docker-compose.release.yml`, `render.yaml`, `apps/web/vercel.json`.
- Worker memory/release: `services/media-worker/src/media_worker/memory.py`, `services/media-worker/src/media_worker/transcription.py`, `services/media-worker/src/media_worker/vision.py`, `services/media-worker/src/media_worker/pipeline.py`, `apps/api/src/media/media-stage.processor.ts`.
- Entrega: `.github/workflows/release-gate.yml`, `.github/workflows/ci.yml`, `scripts/acceptance/*`, `scripts/deploy/wait-render.mjs`, `scripts/infra/configure-r2.mjs`.

## Riscos e limites aceitos

- Worker Standard de 2 GB pode operar apenas serialmente com modelo `tiny` em CPU/int8; escala horizontal e workloads maiores estão fora da Opção A.
- O deploy live depende de tokens/IDs Render, Neon, R2, Vercel e GitHub ainda não fornecidos.
- A mudança do pepper invalida sessões de refresh existentes, conforme planejado.
- O teste de 5 GiB consome banda e armazenamento reais; deve ser executado conscientemente e o vídeo de teste removido depois.
- Custo-base esperado da demo: aproximadamente US$48/mês para API Starter, worker Standard, KV Starter e 25 GB de disco; tráfego e serviços externos podem alterar o total.

## Rollback

Desabilitar `DEMO_DEPLOY_ENABLED`, reverter API e worker Render para o mesmo SHA compatível anterior e usar rollback Vercel. Migrations desta entrega são aditivas; não executar down migration em produção.

## Veredito

A arquitetura e automação estão preparadas em nível de repositório para uma **demo pública automatizada, com deploy contínuo e fluxo principal validável**. O gate local completo e a regressão de 5 GiB passaram; o checklist live permanece aberto até provisionamento externo, E2E externo, smoke pós-deploy e observação de dez minutos nos serviços gerenciados.
