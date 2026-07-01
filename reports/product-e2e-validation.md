# Product E2E Validation — ClipBR / Supercorteslikes

Data: 2026-06-26  
Ambiente: local Docker Compose `clipbr-option-a-gate`, perfil `local-full`  
API: `http://localhost:53101`  
Web: `http://localhost:53100`  
PostgreSQL: `localhost:55433`  
Redis: `localhost:56380`  
MinIO: `localhost:59002`

## Resultado executivo

Status local: ✅ **PASSOU no gate local completo do produto principal**

Ainda não declarar GA/produção comercial: ⚠️ **pendente validação externa real** em Render/Vercel/Neon/R2/Mercado Pago/Resend/Turnstile, backup/restore e soak de produção.

## Escopo validado

- Web renderizando páginas públicas e legais.
- API `/health/ready` e `/health/pipeline`.
- Planos públicos com versão, preço, limites e features.
- Cadastro com aceite legal obrigatório.
- Login e refresh token.
- Solicitação de verificação de e-mail e reset de senha.
- Usage/billing read model.
- Checkout exigindo `Idempotency-Key`.
- Criação de projeto.
- Upload direto multipart para storage.
- Rejeição de upload sem idempotency key.
- Rejeição de upload acima do limite do plano.
- Abort de upload multipart.
- Pipeline com 8 estágios.
- Transcript, segmentos e viral score.
- Clips, títulos, hashtags, SEO e captions.
- Render 9:16, export MP4 e download assinado.
- `ffprobe` do export final: H.264 1080×1920.
- Registro de uso `processing.minutes`.
- Regressão multipart 5 GiB.
- DLQ aberta = 0.
- Outbox pendente = 0.
- 10+ minutos local sem restart.

## Comandos executados

```bash
open -a Docker
docker info --format '{{json .ServerVersion}}'

WEB_PORT=53100 \
PORT=53101 \
POSTGRES_PORT=55433 \
REDIS_PORT=56380 \
MINIO_API_PORT=59002 \
MINIO_CONSOLE_PORT=59003 \
S3_PUBLIC_ENDPOINT=http://localhost:59002 \
docker compose -f docker-compose.local.yml -p clipbr-option-a-gate --profile local-full up --build --detach --wait

docker compose -f docker-compose.local.yml -p clipbr-option-a-gate --profile local-full exec -T media-worker \
  ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=1280x720:rate=25 \
  -f lavfi -i "flite=text='A tecnologia muda rapidamente. Este teste valida um produto completo de ponta a ponta.'" \
  -t 16 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /data/clipbr-option-a.mp4

docker cp "$(docker compose -f docker-compose.local.yml -p clipbr-option-a-gate --profile local-full ps -q media-worker):/data/clipbr-option-a.mp4" \
  /tmp/clipbr-option-a.mp4

DATABASE_URL='postgresql://clipbr_local:clipbr_local_9Tq4xV7mK2pR8sW6@localhost:55433/clipbr?schema=public' \
PRODUCT_E2E_API_URL=http://localhost:53101 \
PRODUCT_E2E_WEB_URL=http://localhost:53100 \
PRODUCT_E2E_COMPOSE_FILE=docker-compose.local.yml \
PRODUCT_E2E_MEDIA_PROFILE=local-full \
COMPOSE_PROJECT_NAME=clipbr-option-a-gate \
PRODUCT_E2E_VIDEO_PATH=/tmp/clipbr-option-a.mp4 \
PRODUCT_E2E_GENERATE_FIXTURE=false \
npm run acceptance:product

ACCEPTANCE_API_URL=http://localhost:53101 npm run acceptance:direct:5g

npm run typecheck
npm run lint
npm test --workspace @clipbr/api
npm run test:coverage
npm test --workspace @clipbr/web

rm -rf /tmp/clipbr-media-test-venv
python3 -m venv /tmp/clipbr-media-test-venv
/tmp/clipbr-media-test-venv/bin/python -m pip install --upgrade pip
/tmp/clipbr-media-test-venv/bin/python -m pip install -e 'services/media-worker[test]'
/tmp/clipbr-media-test-venv/bin/python -m pytest services/media-worker/tests \
  --cov=media_worker --cov-branch --cov-report=term-missing --cov-fail-under=60
```

## Evidências principais

### Product E2E

Resultado:

```json
{
  "status": "PASS",
  "suite": "product-e2e-ga-v1",
  "videoId": "643904cd-21a3-491b-b4b7-91366331e112",
  "pipelineRunId": "81b7d4de-4f0c-4d6e-8eda-e21873646542",
  "uploadParts": 1,
  "transcriptCharacters": 107,
  "segments": 1,
  "scores": 1,
  "clips": 1,
  "downloadStatus": 200,
  "video": {
    "codec_name": "h264",
    "width": 1080,
    "height": 1920
  },
  "usageBefore": {
    "minutes": 0,
    "limit": 60,
    "remaining": 60
  },
  "usageAfter": {
    "minutes": 0.1,
    "limit": 60,
    "remaining": 59.9
  }
}
```

Estágios:

```txt
INGESTION      SUCCEEDED attempts=1
TRANSCRIPTION  SUCCEEDED attempts=1
SEGMENTATION   SUCCEEDED attempts=1
SCORING        SUCCEEDED attempts=1
CLIPS          SUCCEEDED attempts=1
CAPTIONS       SUCCEEDED attempts=1
RENDERING      SUCCEEDED attempts=1
EXPORTS        SUCCEEDED attempts=1
```

### Regressão 5 GiB

```json
{
  "status": "PASS",
  "videoId": "48147713-4f97-49e5-a6e0-cfb38eca0e92",
  "sizeBytes": "5368709120",
  "parts": 80
}
```

### Banco

```json
{
  "videoId": "643904cd-21a3-491b-b4b7-91366331e112",
  "pipelineRunId": "81b7d4de-4f0c-4d6e-8eda-e21873646542",
  "status": "SUCCEEDED",
  "durationMs": "6256",
  "clips": 1,
  "exportsReady": 1,
  "usage": [
    {
      "type": "processing.minutes",
      "quantity": "0.1043",
      "unit": "minute",
      "idempotencyKey": "processing.minutes:643904cd-21a3-491b-b4b7-91366331e112"
    },
    {
      "type": "export.downloaded",
      "quantity": "1",
      "unit": "download"
    }
  ],
  "deadLettersOpen": 0,
  "outboxUnpublished": 0
}
```

### Health

```json
{
  "status": "ok",
  "build": "development",
  "database": "up",
  "redis": "up",
  "storage": "up",
  "outboxRelay": "up",
  "queues": "registered",
  "configuration": "valid"
}
```

Pipeline:

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

### Estabilidade local

Após a janela de 10 minutos:

```txt
clipbr-option-a-gate-api-1 restart=0 status=running exit=0
clipbr-option-a-gate-media-worker-1 restart=0 status=running exit=0
clipbr-option-a-gate-minio-1 restart=0 status=running exit=0
clipbr-option-a-gate-postgres-1 restart=0 status=running exit=0
clipbr-option-a-gate-redis-1 restart=0 status=running exit=0
clipbr-option-a-gate-web-1 restart=0 status=running exit=0
clipbr-option-a-gate-worker-1 restart=0 status=running exit=0
```

### Testes e cobertura

```txt
npm run typecheck                    PASS
npm run lint                         PASS
npm test --workspace @clipbr/api     PASS — 64 tests
npm test --workspace @clipbr/web     PASS — 14 tests
npm run test:coverage                PASS
media-worker pytest                  PASS — 30 tests
media-worker coverage                PASS — 72.68% total
```

Cobertura API:

```txt
Statements 78.69%
Branches   62.39%
Functions  79.38%
Lines      82.33%
```

## Erros encontrados nesta rodada

### 1. Docker daemon offline

Sintoma:

```txt
failed to connect to the docker API at unix:///Users/arturconrado/.docker/run/docker.sock
```

Status: ✅ resolvido localmente com `open -a Docker`.

Correção recomendada:

- No runbook local/CI, falhar cedo com mensagem clara quando Docker não estiver ativo.

### 2. `/billing/plans` exigia JWT

Sintoma:

```txt
GET /billing/plans returned 401: Bearer access token is required
```

Causa:

- Controller de billing não marcava a rota pública.

Status: ✅ corrigido.

Arquivo:

- `apps/api/src/billing/billing.controller.ts`

### 3. Quota/usage não era obrigatório em runtime

Sintoma:

```txt
Processing minutes usage was not recorded
```

Causa:

- `UsageService` estava injetado como `@Optional()` em pontos críticos.
- `MediaModule`, `VideosModule`, `QueuesModule` e `BillingModule` não importavam explicitamente `UsageModule`.
- A pipeline podia processar sem gravar `processing.minutes`, quebrando enforcement comercial.

Status: ✅ corrigido.

Arquivos:

- `apps/api/src/media/media.module.ts`
- `apps/api/src/videos/videos.module.ts`
- `apps/api/src/queues/queues.module.ts`
- `apps/api/src/billing/billing.module.ts`
- `apps/api/src/media/media-stage.processor.ts`
- `apps/api/src/videos/direct-upload.service.ts`
- `apps/api/src/videos/video-upload.service.ts`
- `apps/api/src/queues/outbox-relay.service.ts`

### 4. Harness E2E dependia de `ffmpeg` no host

Sintoma:

```txt
spawnSync ffmpeg ENOENT
```

Causa:

- O script tentava gerar fixture determinístico no macOS, mas `ffmpeg` não estava instalado no host.

Status: ✅ corrigido no harness.

Correção:

- `scripts/acceptance/product-e2e.mjs` agora tenta usar `ffmpeg` local e, se ausente, usa o `ffmpeg` do container `media-worker`.

### 5. Rate limit deixava o E2E flaky

Sintoma:

```txt
POST /auth/register returned 429: Rate limit exceeded
```

Causa:

- A bateria faz testes negativos e positivos de auth em sequência; várias execuções locais seguidas atingiram rate limit.

Status: ✅ corrigido no harness.

Correção:

- `scripts/acceptance/product-e2e.mjs` respeita `429` e retry com `retry-after`/mensagem da API.

### 6. Script manual de estabilidade falhou em zsh

Sintoma:

```txt
zsh: read-only variable: status
```

Causa:

- O shell `zsh` reserva a variável `status`.

Status: ✅ contornado.

Correção recomendada:

- Usar `bash` ou variável `state_status` nos comandos de estabilidade documentados.

### 7. Python local sem ambiente de teste

Sintomas:

```txt
python: command not found
pytest: unrecognized arguments: --cov
ModuleNotFoundError: No module named 'fastapi'
ModuleNotFoundError: No module named 'media_worker'
```

Causa:

- Python global do macOS não estava provisionado com `pytest-cov`, `fastapi` e pacote editável do media-worker.

Status: ✅ resolvido para esta rodada com venv temporário.

Correção recomendada:

- Criar script oficial, por exemplo `npm run test:media`, que cria/usa venv ou documenta:

```bash
python3 -m venv .venv-media
.venv-media/bin/python -m pip install -e 'services/media-worker[test]'
.venv-media/bin/python -m pytest services/media-worker/tests --cov=media_worker --cov-branch --cov-fail-under=60
```

### 8. Warning não bloqueante no outbox após teste 5 GiB

Log:

```txt
Outbox event ... discarded: pipeline references for video.uploaded.v2 are no longer available; discarding stale outbox event
```

Causa provável:

- O teste 5 GiB confirma upload e apaga o vídeo imediatamente. O relay pode encontrar um evento de upload cujo vídeo já foi removido.

Status: ⚠️ não bloqueante nesta rodada.

Evidência:

- DLQ aberta = 0.
- Outbox pendente = 0.
- Health pipeline = ok.

Correção recomendada:

- Considerar cancelar/invalidar outbox pendente ao deletar vídeo recém-enviado, ou reduzir o log para `debug` quando for stale esperado por delete legítimo.

## Arquivos alterados nesta rodada

- `scripts/acceptance/product-e2e.mjs`
- `package.json`
- `.github/workflows/release-gate.yml`
- `README_DEPLOY.md`
- `RELEASE_GA_CHECKLIST.md`
- `apps/api/src/billing/billing.controller.ts`
- `apps/api/src/billing/billing.module.ts`
- `apps/api/src/media/media.module.ts`
- `apps/api/src/media/media-stage.processor.ts`
- `apps/api/src/queues/queues.module.ts`
- `apps/api/src/queues/outbox-relay.service.ts`
- `apps/api/src/videos/videos.module.ts`
- `apps/api/src/videos/direct-upload.service.ts`
- `apps/api/src/videos/video-upload.service.ts`
- `apps/api/src/videos/direct-upload.service.spec.ts`
- `apps/api/src/videos/video-upload.service.spec.ts`
- `apps/api/test/media-stage-processor.spec.ts`
- `apps/api/test/queues-recovery.spec.ts`
- `apps/api/test/videos.e2e.spec.ts`
- `reports/product-e2e-validation.md`

## Pendências para declarar produção/GA

Esses itens não foram validados localmente e continuam obrigatórios antes de lançamento comercial:

1. Smoke externo real em Render + Vercel + Neon + Render KV + Cloudflare R2.
2. Mercado Pago sandbox/live com checkout real e webhook assinado.
3. Resend entregando verificação de e-mail e reset.
4. Turnstile habilitado e validado em produção.
5. R2 CORS/lifecycle final com domínio real.
6. Neon backup ativo e restore drill.
7. Soak de produção por 24 horas com synthetic checks.
8. Domínio final, TLS e CORS final.
9. Dashboards/alertas externos.
10. Rollback testado em Render e Vercel.

## Veredito

Local product gate: ✅ **APROVADO**

Produção comercial/GA: ⚠️ **NÃO DECLARAR AINDA** até passar smoke externo, billing real, e-mail real, Turnstile, backup/restore e soak de 24h.
