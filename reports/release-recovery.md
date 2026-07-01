# Release Recovery — ClipBR / SuperCortesLikes

Data do gate: 2026-06-21 22:52 BRT  
Projeto isolado: `clipbr-release-gate`  
Resultado: **✅ RELEASE RECUPERADA**

## Escopo e decisão

O recovery ficou restrito aos bloqueadores operacionais: imagens, runtime, perfis
Compose, health checks, storage, filas, upload, processamento, exportação, testes,
CI e manifests de produção. Billing, analytics, integrações sociais e novas
funcionalidades de produto não foram alterados.

Todos os gates absolutos passaram: build, testes, Docker, PostgreSQL, Redis, API,
worker Node, media-worker, upload, processamento e exportação.

## Causas raiz

1. O runtime Node copiava apenas o `node_modules` raiz, mas o npm workspace
   instalava `ioredis` no `node_modules` de `apps/api`; o prune/install anterior
   também substituía artefatos gerados do Prisma.
2. A imagem Python não instalava o conjunto real de IA nem validava imports no
   build. FFmpeg/FFprobe e as bibliotecas opcionais podiam faltar sem impedir o
   worker de ficar ready.
3. O Compose não possuía gates distintos para desenvolvimento leve, release e
   production, e não expressava todas as dependências saudáveis.
4. A URL interna do S3/MinIO era reutilizada na assinatura de download, expondo
   `minio:9000` para o cliente externo.
5. O relay de outbox atualizava um estágio incondicionalmente para `QUEUED`,
   podendo sobrescrever um estágio já `PROCESSING` e provocar retry espúrio.
6. A cobertura media um subconjunto insuficiente e o CI não construía/publicava
   todas as imagens de runtime.

## Correções aplicadas

- API/worker Node com estágio limpo `npm ci --omit=dev`, sem prune destrutivo,
  módulos aninhados copiados, Prisma gerado preservado e smoke de `ioredis`,
  BullMQ e Prisma no build/runtime.
- Imagens Python `lite` e `ai`; a imagem `ai` fixa versões compatíveis de
  WhisperX 3.3.1, NumPy 1.26.4, Torch 2.5.1, OpenCV 4.10, MediaPipe 0.10.18 e
  Ultralytics 8.4.72. O build executa imports reais.
- FFmpeg e FFprobe instalados e verificados na imagem.
- Perfis `local-lite`, `release` e `production`. O gate `release` usa modelo
  `tiny`, CPU/int8, batch 1, IA obrigatória e diarização desabilitada.
- `/health/live` valida processo; `/health/ready` valida imports, FFmpeg,
  FFprobe, `HeadBucket` no storage e, quando aplicável, `HF_TOKEN`.
- Heartbeat Redis por instância do worker Node somente depois de validar
  PostgreSQL e Redis; healthcheck também valida o media-worker.
- `S3_PUBLIC_ENDPOINT` separado do endpoint interno.
- Relay de outbox com atualização condicional `PENDING -> QUEUED`, eliminando a
  corrida observada.
- Helm com media-worker, Service, probes, secrets e PVC RWX compartilhado com o
  worker Node.
- CI com cobertura obrigatória, builds e smoke tests de API, web e media-worker,
  scans de imagens, validação Compose/Helm e publicação das imagens imutáveis.

## Arquivos do recovery

- Runtime/configuração: `apps/api/Dockerfile`, `apps/web/Dockerfile`,
  `apps/api/package.json`, `package-lock.json`, `.env.example`,
  `docker-compose.yml`, `README.md`.
- API/filas/storage: `apps/api/src/config/env.ts`,
  `apps/api/src/storage/r2-storage.service.ts`,
  `apps/api/src/media/media-stage.processor.ts`,
  `apps/api/src/queues/outbox-relay.service.ts`,
  `apps/api/src/queues/worker-heartbeat.service.ts`,
  `apps/api/src/worker-app.module.ts`, `apps/api/src/worker-health.ts`.
- Worker Python: `services/media-worker/Dockerfile`, `requirements.txt`,
  `requirements-ai.txt`, `pyproject.toml`, `src/media_worker/app.py`,
  `src/media_worker/config.py`, `src/media_worker/transcription.py`.
- Testes/gates: `apps/api/vitest.config.ts`, os testes em `apps/api/test/`,
  `services/media-worker/tests/test_pipeline_execution.py`,
  `services/media-worker/tests/test_runtime_recovery.py`,
  `services/media-worker/tests/test_media_recovery.py`,
  `services/media-worker/scripts/check_coverage.py`,
  `scripts/acceptance/release-recovery.mjs` e
  `scripts/acceptance/epic1-upload.mjs`.
- Deploy/CI: `.github/workflows/ci.yml`, `infra/helm/clipbr/values.yaml`,
  `values.schema.json`, `tests/values.yaml`, `templates/configmap.yaml`,
  `templates/worker-deployment.yaml`, `templates/networkpolicy.yaml`,
  `templates/media-worker-deployment.yaml` e
  `templates/media-worker-service.yaml`.

## Comandos e resultados

```text
docker compose -p clipbr-release-gate --profile release up -d --build
PASS — cinco imagens construídas; imports de IA: ai-imports-ok

npm run test:coverage
PASS — 8 arquivos / 41 testes

npm run test --workspace @clipbr/web
PASS — 4 arquivos / 11 testes

.venv/bin/pytest tests --cov=media_worker --cov-branch --cov-fail-under=60
PASS — 28 testes; gate separado das quatro métricas aprovado

node scripts/acceptance/release-recovery.mjs
PASS — executado duas vezes em concorrência, sem retry

ACCEPTANCE_SIZE_BYTES=5368709120 node scripts/acceptance/epic1-upload.mjs
PASS — 5.0 GiB persistidos com checksum confirmado

docker compose --profile local-lite config --quiet
docker compose --profile release config --quiet
docker compose --profile production config --quiet
PASS

helm lint / helm template
PASS — 0 charts failed; media-worker, probes e PVC presentes

npm audit --omit=dev --audit-level=high
PASS — 0 vulnerabilidades de produção
```

## Health e estabilidade

Snapshot inicial:

```json
{"apiLive":{"status":"ok"}}
{"apiReady":{"status":"ok","database":"up","redis":"up","outboxRelay":"up"}}
{"mediaLive":{"status":"ok","service":"media-worker","version":"0.1.0"}}
{"mediaReady":{"status":"ready","required":["ffmpeg","ffprobe","storage","whisperx","opencv","mediapipe","yolo"],"dependencies":{"ffmpeg":true,"ffprobe":true,"whisperx":true,"opencv":true,"mediapipe":true,"yolo":true,"storage":true,"huggingFaceToken":false}}}
```

Entre `2026-06-22T01:38:42Z` e `2026-06-22T01:48:48Z` foram coletadas
11 amostras. API, web, worker Node, media-worker, PostgreSQL, Redis e MinIO
permaneceram `healthy`, `running=true` e `RestartCount=0`. O heartbeat da
instância ficou presente em
`clipbr-production:heartbeat:pipeline-worker:<instance>`.

Os logs sanitizados registraram `All eight media pipeline workers are ready` e
respostas 200 dos readiness checks. Não houve fatal, panic, uncaught, unhandled
ou traceback. Warnings de detecção de CPU do ONNX e de compatibilidade futura do
Torch não afetaram o gate.

## Fluxos reais

### Fluxos 1–4

Foram executados dois fluxos completos concorrentes:

- Vídeos: `996c73bc-8d77-4b72-bab2-bcd2986b22dc` e
  `f90cf731-4720-4b3c-b762-abb2ebb2e07e`.
- Cada pipeline concluiu `INGESTION`, `TRANSCRIPTION`, `SEGMENTATION`, `SCORING`,
  `CLIPS`, `CAPTIONS`, `RENDERING` e `EXPORTS` como `SUCCEEDED`, todos com
  `attempts=1`.
- Banco final: 2 pipelines `SUCCEEDED`, 16 estágios `SUCCEEDED`, 2 transcripts,
  4 segmentos, 4 viral scores, 2 clips e 2 exports.
- DLQ aberta: 0. Outbox não publicada: 0.
- Cada fluxo persistiu título, hashtags, captions SRT/ASS e os objetos de source
  e export no MinIO.
- Downloads assinados retornaram HTTP 200 usando o endpoint público.
- Os dois MP4 finais passaram no FFprobe: H.264, 1080x1920.

### Upload máximo

O teste de 5 GiB foi executado em `clipbr-upload-gate`, usando a mesma imagem da
API e uma stack local-lite isolada, sem worker para não enviar o arquivo
sintético ao pipeline:

```text
videoId: 1f7e68e5-ed32-4f24-959c-ae3f1f184b12
status: UPLOADED
sizeBytes: 5368709120
sha256: e2bdb2172667361b64f6ae2eb84a3845f64e2d85214f637d1226f25da9ae2ad4
MinIO: 5.0 GiB, multipart ETag com 80 partes
API/PostgreSQL/Redis/MinIO: healthy, RestartCount=0
```

Os projetos `clipbr-upload-gate` e `clipbr-release-gate`, e somente os volumes
pertencentes a eles, foram removidos depois da coleta da evidência.

## Cobertura

| Componente | Statements | Branches | Functions | Lines | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| API | 83.51% | 62.22% | 89.59% | 86.76% | PASS |
| media-worker | 76.32% | 63.39% | 81.52% | 76.32% | PASS |

O checker Python calcula e bloqueia statements, lines, functions e branches
separadamente. A meta posterior de 80% permanece deliberadamente fora deste
recovery.

## Score recalculado

| Área de recovery | Pontos |
| --- | ---: |
| Docker e infraestrutura local | 20/20 |
| API, banco, Redis, storage e upload | 15/15 |
| Worker Node e IA real | 20/20 |
| Processamento, clips e exportação | 25/25 |
| Testes, cobertura e CI | 13/15 |
| Production/Helm | 4/5 |
| **Total** | **97/100** |

Descontos: cobertura ainda abaixo da meta posterior de 80% e production externo
validado por build/configuração/Helm, mas não executado sem credenciais
gerenciadas. Esses itens não bloqueiam o recovery conforme as premissas
aprovadas.

## Pendências não bloqueantes

- Elevar API e media-worker para cobertura >= 80% em uma release posterior.
- Executar smoke real do perfil production quando PostgreSQL, Redis, R2,
  `HF_TOKEN` e demais secrets gerenciados estiverem disponíveis.
- Otimização de memória/model cache foi tratada no hardening da Opção A para
  reduzir risco de OOM no worker serial; escala horizontal continua fora deste
  recovery.

## Definition of Done

| Gate | Resultado |
| --- | --- |
| Docker completo | PASS |
| API | PASS |
| Worker Node + media-worker | PASS |
| Redis | PASS |
| PostgreSQL | PASS |
| Upload, incluindo 5 GiB | PASS |
| Processamento | PASS |
| Exportação e download | PASS |

**✅ RELEASE RECUPERADA.**
