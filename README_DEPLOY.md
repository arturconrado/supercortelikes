# Deploy da demo — Opção A

Esta configuração entrega o frontend na Vercel, API e fila no Render, banco no Neon e objetos privados no Cloudflare R2. O único worker Render reúne o consumidor BullMQ e o media-worker Python no mesmo container e usa `/data` como disco persistente.

Se o alvo for o lançamento rápido em VPS all-in-one, use o runbook [README_VPS_DEPLOY.md](/Users/arturconrado/supercortelikes/README_VPS_DEPLOY.md). O perfil econômico padrão é 4 vCPU / 8 GB RAM com `VPS_SIZE_PROFILE=budget`; DigitalOcean continua suportado e Hetzner é a alternativa barata recomendada com `VPS_PROVIDER=hetzner`. Ele cobre `docker-compose.vps.yml`, `Caddyfile`, `.env.vps.example`, scripts de preflight/provisionamento/deploy/smoke/backup/rollback e a esteira GitHub Actions genérica `.github/workflows/vps-cicd.yml` para deploy em qualquer VPS via SSH + GHCR.

Para validação manual local em modo “produção em uma caixa só”, use o ambiente all-in-one:

```bash
scripts/local-prod-one/up.sh
```

Ele sobe Web, API, worker Node, media-worker Python/IA, PostgreSQL, Redis e MinIO dentro de um único container Docker. O comando fica preso no terminal fazendo streaming dos logs; o supervisor também emite heartbeat JSON contínuo com status de Postgres, Redis, storage, media-worker, API, web, DLQ e outbox. O sistema não deve ficar silencioso durante boot nem processamento.

URLs locais:

- Web: `http://localhost:3330`
- API: `http://localhost:3331`
- Storage S3/MinIO: `http://localhost:3332`
- Console MinIO: `http://localhost:3333`

Comandos úteis:

```bash
scripts/local-prod-one/logs.sh
scripts/local-prod-one/smoke.sh
scripts/local-prod-one/down.sh
```

Para ativar scoring com LLM via OpenRouter, coloque os valores apenas em arquivos locais/secretos:

```bash
LLM_PROVIDER=openrouter
LLM_API_KEY=...
LLM_MODEL=openai/gpt-4o-mini
LLM_TIMEOUT_SECONDS=45
```

No all-in-one local use `.env.one`; na VPS use `.env.production`. Se a OpenRouter falhar ou responder JSON inválido, o media-worker mantém o fallback heurístico local e o pipeline não deve cair por isso.

## 1. Recursos externos

1. Crie um projeto Neon em Virginia e copie as URLs pooled e direct.
2. Crie um bucket R2 privado e credenciais limitadas ao bucket.
3. Importe `render.yaml` como Blueprint. Preencha os valores `sync: false` e mantenha o Key Value em `noeviction`.
4. Na Vercel, importe o repositório com Root Directory `apps/web` e habilite **Include source files outside of the Root Directory**. Defina `NEXT_PUBLIC_API_URL` com a URL estável da API.
5. Execute a configuração idempotente de CORS/lifecycle do R2:

```bash
R2_CORS_ORIGINS='https://SEU-PROJETO.vercel.app,http://localhost:3000' npm run infra:r2
```

As URLs multipart usam sempre `S3_ENDPOINT` (`https://<account>.r2.cloudflarestorage.com`). Um custom domain pode ser usado em `S3_PUBLIC_BASE_URL` apenas para leitura pública planejada; ele não assina uploads.

## 2. Segredos e variáveis

Copie `.env.example` como referência. Em `APP_ENV=release|production`, API e worker encerram o boot se banco direto, Redis, storage, segredos ou IA obrigatória estiverem ausentes.

Configure no environment GitHub `demo-production`:

- Secrets: `RENDER_API_DEPLOY_HOOK_URL`, `RENDER_WORKER_DEPLOY_HOOK_URL`, `RENDER_API_KEY`, `RENDER_API_SERVICE_ID`, `RENDER_WORKER_SERVICE_ID`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
- Variables: `DEMO_DEPLOY_ENABLED=true`, `RENDER_API_URL` e `VERCEL_APP_URL`.

Proteja `main` exigindo o job reutilizável `gate`. Render e Vercel devem permanecer com auto-deploy desligado; somente `.github/workflows/ci.yml` promove o SHA aprovado.

## 3. Validação local

```bash
# Sem pipeline de IA
docker compose -f docker-compose.local.yml --profile local-lite up --build

# Fluxo completo, multipart direto e IA local
docker compose -f docker-compose.local.yml -p clipbr-option-a --profile local-full up --build --detach --wait
PRODUCT_E2E_COMPOSE_FILE=docker-compose.local.yml \
PRODUCT_E2E_MEDIA_PROFILE=local-full \
PRODUCT_E2E_WEB_URL=http://localhost:3000 \
COMPOSE_PROJECT_NAME=clipbr-option-a \
npm run acceptance:product
```

O `acceptance:product` é o E2E canônico do produto completo: valida health, páginas legais, planos/usage, auth com aceite legal, refresh token, verificação/reset de e-mail, projeto, multipart direto, limite de quota, abort de upload, pipeline, transcript, segmentos, viral score, clips, SEO, captions, render, download assinado, `ffprobe`, DLQ e outbox.

O script antigo `scripts/acceptance/release-recovery.mjs` continua disponível para diagnóstico focado em recovery.

`docker-compose.release.yml` não cria banco, Redis nem storage: ele valida exatamente as conexões externas da demo.

## 4. Operação e rollback

- Render API: `/health/live`, `/health/ready` e `/health/pipeline`.
- O worker é saudável somente quando Node, Python, Redis, R2, FFmpeg/FFprobe e bibliotecas habilitadas respondem.
- Concorrência pesada fica fixa em 1. O watchdog encerra o bundle se um processo morrer ou o heartbeat parar.
- O deploy espera API e worker atingirem `live`, valida o SHA, publica o prebuilt Vercel e executa smoke externo.
- Para GA comercial, também execute `npm run acceptance:ga-soak` com `SOAK_DURATION_MINUTES=1440`, `SOAK_INTERVAL_SECONDS=1800` e `SOAK_FLOW_COMMAND` apontando para o fluxo completo autenticado.
- Runbooks operacionais ficam em `docs/runbooks/`; scripts de suporte ficam em `scripts/support/`.
- Para rollback, desative `DEMO_DEPLOY_ENABLED`, use **Rollback** nos dois serviços Render para o mesmo SHA anterior e `vercel rollback <deployment-url>`. Não reverta migrations destrutivamente; restaure apenas código compatível com o schema atual.

Referências: [Render Blueprint](https://render.com/docs/blueprint-spec), [Render Key Value](https://render.com/docs/key-value), [Vercel monorepos](https://vercel.com/docs/monorepos), [R2 multipart](https://developers.cloudflare.com/r2/objects/multipart-objects/).
