# Validação de Produção — PicaShorts

Data: 2026-07-02  
Ambiente: VPS DigitalOcean all-in-one  
Web: https://picashorts.com  
API: https://api.picashorts.com  
Storage: https://storage.picashorts.com  
Build em produção validada: `5c15c79d46d5264f514e4893693795c48d1ef2af`  
GitHub Actions deploy: https://github.com/arturconrado/supercortelikes/actions/runs/28618482512

## Resultado executivo

Status operacional: ⚠️ PRODUÇÃO PARCIALMENTE VALIDADA, MAS AINDA NÃO APROVADA COMO ESTÁVEL/GA.

O deploy novo foi publicado com sucesso, o produto está acessível na web, a marca pública já aparece como PicaShorts, DNS/TLS estão funcionando, API/storage respondem e o fluxo principal por upload direto passou de ponta a ponta em produção:

`register/login → projeto → upload multipart → fila → transcrição → segmentos → score → clips → legendas → render → export → download assinado`.

Porém há um bloqueador real remanescente: `/health/pipeline` está `degraded` porque existe 1 DLQ aberta em ingestão de URL/YouTube. A causa capturada nos logs é bloqueio anti-bot do YouTube pelo `yt-dlp`:

```text
ERROR: [youtube] qHlquy4-YEs: Sign in to confirm you’re not a bot.
```

Enquanto houver DLQ aberta, o produto não deve ser declarado “produção estável” para todos os fluxos. O fluxo de upload direto está OK; o fluxo de import por YouTube/URL precisa correção operacional/produto.

## O que passou

| Área | Resultado |
|---|---:|
| Deploy GitHub Actions → VPS | PASS |
| DNS `picashorts.com` | PASS |
| DNS `api.picashorts.com` | PASS |
| DNS `storage.picashorts.com` | PASS |
| TLS/HTTPS via Caddy | PASS |
| Branding público PicaShorts | PASS |
| API `/health/ready` | PASS |
| Storage `/minio/health/live` | PASS |
| Containers principais running | PASS |
| Restart count pós-deploy | PASS, `0` |
| Registro/login via API | PASS |
| Criação de projeto | PASS |
| Upload multipart direto | PASS |
| Confirmação de upload | PASS |
| Worker consumindo fila | PASS |
| Pipeline por upload direto | PASS |
| Transcript/segmentos/score | PASS |
| Clips/captions/render/export/download | PASS |
| `ffprobe` do MP4 final via container | PASS, H.264 1080×1920 |
| Browser smoke autenticado | PASS |
| Páginas públicas legais | PASS |

## O que falhou / pendências críticas

| Área | Resultado |
|---|---:|
| `/health/pipeline` final | FAIL/DEGRADED |
| DLQ aberta | FAIL, `deadLettersOpen=1` |
| Import YouTube/URL em produção | FAIL para `https://www.youtube.com/watch?v=qHlquy4-YEs` |
| LLM real em produção | Pendente, `LLM_PROVIDER=none` |
| E-mail verificado | Pendente, `EMAIL_VERIFICATION_REQUIRED=false` |
| Turnstile | Pendente, `TURNSTILE_REQUIRED=false` |
| Soak 24h | Pendente |

## Evidências de infraestrutura

### DNS

```text
picashorts.com          162.243.114.141
api.picashorts.com      162.243.114.141
storage.picashorts.com  162.243.114.141
```

### Health da API

```json
{
  "status": "ok",
  "build": "5c15c79d46d5264f514e4893693795c48d1ef2af",
  "database": "up",
  "redis": "up",
  "storage": "up",
  "outboxRelay": "up",
  "queues": "registered",
  "configuration": "valid"
}
```

### Health do pipeline

Snapshot pós-E2E:

```json
{
  "status": "degraded",
  "outbox": {
    "relay": "up",
    "unpublished": 0,
    "oldestAgeMs": 0
  },
  "deadLettersOpen": 1,
  "queues": {
    "ingestion": {
      "workers": 1,
      "waiting": 0,
      "active": 0,
      "failed": 8,
      "paused": false
    },
    "dead-letter": {
      "waiting": 8,
      "active": 0
    }
  }
}
```

Observação: os contadores BullMQ ainda carregam histórico de falhas antigas (`failed=8`, `dead-letter.waiting=8`). O critério operacional mais importante é `deadLettersOpen`; ele está em `1` e precisa ser tratado.

### Containers

```text
clipbr-vps-worker-1         Up About a minute (healthy)
clipbr-vps-web-1            Up About a minute (healthy)
clipbr-vps-api-1            Up About a minute (healthy)
clipbr-vps-media-worker-1   Up 2 minutes (healthy)
clipbr-vps-caddy-1          Up 3 hours
clipbr-vps-postgres-1       Up 3 hours (healthy)
clipbr-vps-redis-1          Up 3 hours (healthy)
clipbr-vps-minio-1          Up 3 hours (healthy)
```

Restart count pós-deploy: `0` para todos os containers verificados.

### Recursos da VPS

```text
Disco /: 154G total, 34G usado, 121G livre, 22%
RAM: 7.8Gi total, 6.1Gi available
Swap: 8.0Gi total, ~0 usado
```

Snapshot `docker stats --no-stream`:

```text
worker        66 MiB
web           42 MiB
api           86 MiB
media-worker 789 MiB
caddy         77 MiB
postgres      76 MiB
redis         11 MiB
minio        110 MiB
```

### Portas expostas

```text
Públicas: 22, 80, 443
Postgres: 127.0.0.1:55432
Redis: interno
MinIO: interno, exposto somente via Caddy em https://storage.picashorts.com
```

### Configuração runtime sanitizada

```text
APP_ENV=production
NODE_ENV=production
UPLOAD_MODE=direct
ENABLE_AI=true
LLM_PROVIDER=none
LLM_MODEL=openai/gpt-4o-mini
EMAIL_VERIFICATION_REQUIRED=false
TURNSTILE_REQUIRED=false
S3_PUBLIC_ENDPOINT=https://storage.picashorts.com
CORS_ORIGIN=https://picashorts.com
```

## E2E real de produto

Arquivo bruto local: `/tmp/picashorts-product-e2e-prod-latest.log`

Resultado:

```json
{
  "status": "PASS",
  "suite": "product-e2e-ga-v1",
  "apiUrl": "https://api.picashorts.com",
  "account": "product-e2e-d1f53369@clipbr.test",
  "workspaceId": "2798bdb3-b3f2-48ec-972c-43abdb5a9fc5",
  "projectId": "c05df083-1383-4a99-9ee0-d063aa4a061d",
  "videoId": "3fc965b3-3b02-40fa-b8c2-d99ac08a7078",
  "pipelineRunId": "31e081a6-bc67-47aa-b14f-4e41dd06c11a",
  "uploadParts": 1,
  "clips": 1,
  "downloadStatus": 200
}
```

Estágios:

```text
INGESTION     SUCCEEDED attempts=1
TRANSCRIPTION SUCCEEDED attempts=1
SEGMENTATION  SUCCEEDED attempts=1
SCORING       SUCCEEDED attempts=1
CLIPS         SUCCEEDED attempts=1
CAPTIONS      SUCCEEDED attempts=1
RENDERING     SUCCEEDED attempts=1
EXPORTS       SUCCEEDED attempts=1
```

Uso medido:

```text
usageBefore.remaining = 60
usageAfter.minutes    = 0.06
usageAfter.remaining  = 59.94
```

Billing write foi propositalmente pulado:

```text
PRODUCT_E2E_ENABLE_BILLING_WRITE=false
```

## Validação do MP4 exportado

O runner local não tem `ffprobe`, então o arquivo exportado foi copiado para a VPS e validado dentro do `media-worker`:

```json
{
  "streams": [
    {
      "codec_name": "h264",
      "width": 1080,
      "height": 1920
    }
  ]
}
```

Resultado: PASS.

## Browser smoke real

Arquivo bruto local: `/tmp/picashorts-prod-browser-smoke.json`

Resultado:

```json
{
  "status": "PASS",
  "results": [
    { "name": "public legal pages", "status": "PASS" },
    { "name": "dashboard authenticated", "status": "PASS" },
    { "name": "main navigation pages", "status": "PASS" },
    { "name": "upload controls visible and clickable", "status": "PASS" },
    { "name": "video page shows real processed content", "status": "PASS" },
    { "name": "clip editor opens real clip", "status": "PASS" }
  ]
}
```

Escopo validado:

- `/terms`, `/privacy`, `/refunds`;
- login por sessão real;
- `/dashboard`;
- `/upload`;
- `/library`;
- `/projects`;
- `/exports`;
- `/analytics`;
- `/billing`;
- `/settings`;
- detalhe de vídeo processado;
- editor de clip real.

Observação: o primeiro login browser recebeu `429` e precisou respeitar retry. Isso confirma rate limit ativo em produção.

## DLQ aberta — causa raiz

Registro aberto no banco:

```json
{
  "id": "2fdfd165-577b-44c9-9983-328e50158cd5",
  "originalQueue": "ingestion",
  "errorCode": "URL_IMPORT_FAILED",
  "errorMessage": "Unable to import the remote video",
  "redriveCount": 0,
  "pipelineRunId": "3a6160ac-88e3-43c3-be07-965f696a0279",
  "payloadVideoId": "496fe43b-5ad7-42e0-9293-e9e28f1f7424"
}
```

Pipeline associado:

```json
{
  "status": "FAILED",
  "currentStage": "INGESTION",
  "failureCode": "URL_IMPORT_FAILED",
  "failureMessage": "Unable to import the remote video",
  "video": {
    "title": "YouTube qHlquy4-YEs",
    "originalFilename": "youtube-qHlquy4-YEs.mp4",
    "sourceUrl": "https://www.youtube.com/watch?v=qHlquy4-YEs",
    "status": "UPLOADED"
  },
  "stages": [
    {
      "stage": "INGESTION",
      "status": "DEAD_LETTERED",
      "attempts": 10,
      "errorCode": "URL_IMPORT_FAILED"
    }
  ]
}
```

Logs do `media-worker`:

```text
ERROR: [youtube] qHlquy4-YEs: Sign in to confirm you’re not a bot.
POST /v1/stages/ingestion HTTP/1.1 502
```

Interpretação: upload direto está saudável, mas importação por YouTube/URL não é confiável em produção sem estratégia anti-bot/cookies/proxy/fallback.

## Comandos executados

Deploy:

```bash
git push origin main
# workflow_dispatch vps-cicd.yml:
# deploy=true, release_gate=false, digitalocean_mode=validate,
# image_tag=5c15c79d46d5264f514e4893693795c48d1ef2af
```

Health:

```bash
curl -fsS https://api.picashorts.com/health/ready
curl -fsS https://api.picashorts.com/health/pipeline
curl -fsS https://storage.picashorts.com/minio/health/live
```

E2E:

```bash
PRODUCT_E2E_API_URL=https://api.picashorts.com \
PRODUCT_E2E_WEB_URL=https://picashorts.com \
PRODUCT_E2E_VIDEO_PATH=/tmp/picashorts-prod-e2e-fixture.mp4 \
PRODUCT_E2E_GENERATE_FIXTURE=false \
PRODUCT_E2E_SKIP_FFPROBE=true \
PRODUCT_E2E_ENABLE_BILLING_WRITE=false \
PRODUCT_E2E_STABILITY_SECONDS=0 \
npm run acceptance:product
```

Browser smoke:

```bash
node ./picashorts-prod-browser-smoke.tmp.mjs
```

Infra:

```bash
ssh clipbr@162.243.114.141 'docker ps --filter name=clipbr-vps'
ssh clipbr@162.243.114.141 'docker stats --no-stream'
ssh clipbr@162.243.114.141 'df -h / /srv/clipbr/data && free -h'
```

## Correções aplicadas no repo nesta rodada

- Rebranding público para PicaShorts.
- Rotas públicas legais liberadas no AuthProvider.
- Registro não bloqueia Turnstile quando site key está desabilitada.
- `media-worker` agora valida diretórios de workspace/cache no readiness.
- API trata resposta não JSON do media-worker como erro sanitizado.
- `/health/pipeline` agora fica degradado quando há DLQ aberta/outbox pendente.
- Scripts VPS passam a preparar `/srv/clipbr/data/media/pipelines` e `/models`.
- Script de deploy tolera cache de modelos antigo sem abortar em `chmod` recursivo.
- Waivers temporários de Trivy documentados para CVEs sem upgrade seguro no stack atual.

## Lista priorizada de correções

### P0 — Antes de declarar produção estável

1. Resolver import YouTube/URL.
   - Opções: cookies oficiais do `yt-dlp`, proxy/egress dedicado, integração via API autorizada quando possível, ou UX deixando claro que YouTube pode exigir upload manual.
   - Não prometer “qualquer link” enquanto YouTube puder bloquear anti-bot.

2. Tratar a DLQ aberta.
   - Decidir se o vídeo `youtube-qHlquy4-YEs` será redrive após correção ou marcado como resolvido/descartado com auditoria.
   - Não limpar silenciosamente porque parece ser fluxo real de import.

3. Alinhar produção comercial.
   - Configurar LLM real ou declarar fallback.
   - Ativar Resend/e-mail verificado se for requisito de operação.
   - Ativar Turnstile real se for requisito anti-abuso.

4. Rodar soak.
   - mínimo: 10 minutos sem restart após DLQ zerada;
   - ideal GA: 24h com synthetic checks.

### P1 — Robustez de produto

1. Tela de vídeo importado deve mostrar erro claro quando URL falhar.
2. Import por URL não deve criar percepção de sucesso se a validação síncrona já sabe que vai falhar.
3. Criar runbook de DLQ/redrive e comando de suporte seguro.
4. Limpar contadores BullMQ históricos para reduzir ruído operacional.
5. Instalar `ffprobe` no runner/esteira para não precisar validar via container manualmente.

### P2 — Segurança/operacional

1. Rotacionar credenciais expostas durante configuração manual.
2. Remover `localhost` do CSP de produção se ainda aparecer no header.
3. Configurar alertas para `deadLettersOpen > 0`, outbox pendente, API ready, worker ready e disco.
4. Executar restore drill de backup antes de venda comercial.

## Conclusão

PicaShorts está publicado e o fluxo principal por upload direto passou em produção. A infra base está saudável e sem restarts.

Ainda não está 100% estável para declarar produção plena porque o pipeline está degradado por uma DLQ real de import YouTube/URL. O próximo passo é corrigir/definir a estratégia de importação YouTube e zerar a DLQ com auditoria. Depois disso, repetir E2E + browser smoke + observação.
