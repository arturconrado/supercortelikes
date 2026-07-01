# Relatório — GA comercial v1

Data: 2026-06-26  
Estado: **REPO-READY PARA GA COMERCIAL V1 — LIVE PENDENTE DE PROVISIONAMENTO, SMOKE EXTERNO E SOAK 24H**

## Implementado

- Fonte única de entitlements por plano (`FREE`, `PRO`, `BUSINESS`) com versão `2026-06-ga-v1`.
- `GET /billing/plans` retorna preço, features, versão e limites.
- `GET /billing/subscription` retorna assinatura, uso corrente, limites e período de graça.
- `GET /usage/current` expõe quota mensal e limites do workspace.
- `POST /billing/checkout` exige `Idempotency-Key` e persiste checkout.
- Webhooks Mercado Pago são deduplicados por `type:dataId` e persistidos.
- Cadastro exige aceite de Termos e Privacidade com versão.
- Verificação de e-mail, reset de senha via Resend e Turnstile configurável.
- Upload direto aplica quota e limite do plano.
- Pipeline registra minutos processados de forma idempotente.
- Fila usa prioridade por plano.
- `/metrics` expõe HTTP, outbox, DLQ e filas.
- Páginas legais: `/terms`, `/privacy`, `/refunds`.
- Runbooks e scripts de suporte para inspeção, DLQ, cancelamento e uploads órfãos.
- Smoke externo valida API ready/live, web, pipeline, DLQ e outbox.
- Soak GA configurável por `scripts/acceptance/ga-soak.mjs`.

## Comandos executados

```bash
npm run db:generate --workspace @clipbr/api
npm run typecheck
npm test
npm run test:coverage
npm run lint
npm run build
npm run db:validate
DATABASE_URL='postgresql://clipbr_local:***@localhost:55433/clipbr?schema=public' npm run db:migrate:deploy --workspace @clipbr/api
PYTHONPATH=services/media-worker/src services/media-worker/.venv/bin/python -m pytest services/media-worker/tests
docker compose -f docker-compose.local.yml --profile local-lite config --quiet
docker compose -f docker-compose.local.yml --profile local-full config --quiet
docker compose -f docker-compose.release.yml config --quiet
```

Resultados locais:

- Typecheck: PASS
- Unit tests: API 64 testes; Web 14 testes; PASS
- Coverage API: statements 78.65%; branches 62.39%; functions 79.38%; lines 82.29%; PASS
- Lint: PASS
- Build API/Web: PASS
- Prisma validate: PASS
- Migration deploy em Postgres local: PASS
- Media worker pytest: 30 testes; PASS
- Compose local/release e Render/Vercel manifests: PASS

## Arquivos principais

- Entitlements/uso: `apps/api/src/usage/*`
- Billing GA: `apps/api/src/billing/*`
- Auth/legal/abuso: `apps/api/src/auth/*`, `apps/api/src/notifications/*`
- Upload/pipeline enforcement: `apps/api/src/videos/*`, `apps/api/src/media/media-stage.processor.ts`, `apps/api/src/queues/*`
- Observabilidade: `apps/api/src/observability/*`, `infra/monitoring/prometheus/rules.yml`
- Web GA: `apps/web/app/terms`, `apps/web/app/privacy`, `apps/web/app/refunds`, billing/upload/register
- Operação: `docs/runbooks/*`, `scripts/support/*`, `scripts/acceptance/ga-soak.mjs`

## Pendências para declarar GA live

- Provisionar domínio final, Neon, Render, Render KV, R2, Vercel e GitHub environment.
- Configurar Mercado Pago live/sandbox-live, Resend, Turnstile e CORS final.
- Validar R2 privado, lifecycle, URLs assinadas e restore drill Neon.
- Rodar smoke externo com SHA aprovado.
- Rodar soak de 24h com `SOAK_FLOW_COMMAND` executando 3 fluxos completos.
- Confirmar dashboards/alertas externos recebendo `/metrics`.
- Ensaiar rollback com responsáveis.

## Veredito

O produto está preparado no repositório para avançar de beta para **GA comercial v1 SMB Brasil**, mas a declaração de lançamento comercial continua bloqueada até o ambiente externo real passar smoke, soak e operação assistida.
