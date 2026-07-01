# Full E2E Validation — ClipBR / Supercorteslikes

Data: 2026-07-01  
Ambiente: local Docker `local-full` com worker AI real  
Projeto Compose: `clipbr-full-e2e-ai`  
API: `http://localhost:53201`  
Web: `http://localhost:53200`  
Storage público local: `http://localhost:59012`

## Resultado

✅ **PASS local-full E2E**

O produto passou no fluxo principal com stack completa:

- Web
- API NestJS
- PostgreSQL
- Redis/BullMQ
- MinIO
- Node worker
- media-worker AI com WhisperX/OpenCV/MediaPipe/Ultralytics
- upload multipart direto
- pipeline de 8 etapas
- export/download com validação `ffprobe`
- regressão multipart 5 GiB
- E2E browser Playwright
- estabilidade de 10 minutos sem restart

## Comandos executados

```bash
COMPOSE_PROJECT_NAME=clipbr-full-e2e-ai \
PORT=53201 \
WEB_PORT=53200 \
POSTGRES_PORT=55434 \
REDIS_PORT=56381 \
MINIO_API_PORT=59012 \
MINIO_CONSOLE_PORT=59013 \
S3_PUBLIC_ENDPOINT=http://localhost:59012 \
NEXT_PUBLIC_API_URL=http://localhost:53201 \
PUBLIC_API_URL=http://localhost:53201 \
PUBLIC_APP_URL=http://localhost:53200 \
CORS_ORIGIN=http://localhost:53200 \
PRODUCT_E2E_TIMEOUT_MS=3600000 \
ACCEPTANCE_TIMEOUT_MS=3600000 \
npm run gate:local-full-ai
```

```bash
ACCEPTANCE_API_URL=http://localhost:53201 npm run acceptance:direct:5g
```

```bash
npm run test:e2e:web
```

```bash
date -u
sleep 600
date -u
docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $(docker compose -f docker-compose.local.yml -p clipbr-full-e2e-ai --profile local-full ps -q)
curl -fsS http://localhost:53201/health/ready
curl -fsS http://localhost:53201/health/pipeline
```

## Evidências principais

### Build/runtime AI

O build do `media-worker` instalou as dependências AI e executou import real:

```text
ai-imports-ok
```

Imports validados no Dockerfile:

- `yt_dlp`
- `whisperx`
- `cv2`
- `mediapipe`
- `ultralytics`

### Stack Docker

Todos os containers subiram saudáveis:

```text
Container clipbr-full-e2e-ai-api-1 Healthy
Container clipbr-full-e2e-ai-web-1 Healthy
Container clipbr-full-e2e-ai-worker-1 Healthy
Container clipbr-full-e2e-ai-media-worker-1 Healthy
Container clipbr-full-e2e-ai-postgres-1 Healthy
Container clipbr-full-e2e-ai-redis-1 Healthy
Container clipbr-full-e2e-ai-minio-1 Healthy
```

### Fluxo produto completo

Suite: `product-e2e-ga-v1`

```json
{
  "status": "PASS",
  "suite": "product-e2e-ga-v1",
  "uploadParts": 1,
  "stages": [
    { "stage": "INGESTION", "status": "SUCCEEDED" },
    { "stage": "TRANSCRIPTION", "status": "SUCCEEDED" },
    { "stage": "SEGMENTATION", "status": "SUCCEEDED" },
    { "stage": "SCORING", "status": "SUCCEEDED" },
    { "stage": "CLIPS", "status": "SUCCEEDED" },
    { "stage": "CAPTIONS", "status": "SUCCEEDED" },
    { "stage": "RENDERING", "status": "SUCCEEDED" },
    { "stage": "EXPORTS", "status": "SUCCEEDED" }
  ],
  "product": {
    "transcriptCharacters": 107,
    "segments": 1,
    "scores": 1,
    "clips": 1,
    "downloadStatus": 200,
    "video": {
      "codec_name": "h264",
      "width": 1080,
      "height": 1920
    }
  }
}
```

### Filas, DLQ e outbox

Pipeline final:

```json
{
  "status": "ok",
  "outbox": {
    "relay": "up",
    "unpublished": 0,
    "oldestAgeMs": 0
  },
  "deadLettersOpen": 0
}
```

Todas as filas principais tinham `workers: 1`, `waiting: 0`, `active: 0`, `failed: 0`.

### Regressão multipart 5 GiB

```json
{
  "status": "PASS",
  "sizeBytes": "5368709120",
  "parts": 80
}
```

### Browser E2E

Playwright:

```text
8 passed
```

Cenários cobertos:

- cadastro com qualidade de senha e contrato correto;
- importação por URL com redirecionamento para vídeo;
- tela de processamento/cortes;
- preview;
- editor de clip;
- upload direto multipart pelo browser;
- erro útil de importação;
- retry de pipeline;
- biblioteca com thumbnail real.

### Estabilidade 10 minutos

Janela:

- início: `Wed Jul  1 13:42:26 UTC 2026`
- fim: `Wed Jul  1 13:52:26 UTC 2026`

Resultado:

```text
/clipbr-full-e2e-ai-api-1 0 running healthy
/clipbr-full-e2e-ai-media-worker-1 0 running healthy
/clipbr-full-e2e-ai-minio-1 0 running healthy
/clipbr-full-e2e-ai-postgres-1 0 running healthy
/clipbr-full-e2e-ai-redis-1 0 running healthy
/clipbr-full-e2e-ai-web-1 0 running healthy
/clipbr-full-e2e-ai-worker-1 0 running healthy
```

Health final:

```json
{
  "status": "ok",
  "database": "up",
  "redis": "up",
  "storage": "up",
  "outboxRelay": "up",
  "queues": "registered",
  "configuration": "valid"
}
```

## Observações / pendências não bloqueantes do E2E local

- O script `product-e2e` marcou billing write como skipped porque `PRODUCT_E2E_ENABLE_BILLING_WRITE=false`. Isso evita criar cobranças reais em local.
- Integrações externas reais ainda não foram validadas nesta execução: Mercado Pago live/sandbox real, Resend real, Turnstile real, domínio público/TLS e VPS.
- Playwright exibiu warnings de ambiente de desenvolvimento sobre `NO_COLOR`/`FORCE_COLOR` e `eval()` em React dev mode; os testes passaram e isso não afeta build produção.

## Conclusão

✅ O produto está validado no E2E local completo com AI real e fluxo de vídeo funcionando de ponta a ponta.

🚧 Ainda não equivale a go-live comercial externo: falta rodar o smoke no domínio público/VPS com credenciais reais de e-mail, Turnstile e Mercado Pago, além de backup/restore e soak 24h.
