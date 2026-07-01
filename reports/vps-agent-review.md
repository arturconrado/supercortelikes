# Relatório — revisão com agents da produção VPS

Data: 2026-06-26

Status após correções: **repo-ready para deploy controlado em VPS**. Ainda **não declarar produção comercial live** até smoke externo, 5 GiB na VPS, integrações reais, backup/restore e soak 24h passarem.

## Como a revisão foi feita

- Agent `security_review`: executou revisão somente leitura com foco em API security, Caddy, Compose VPS, scripts, upload direto, Turnstile, Resend e Mercado Pago.
- Agent `devops_infra_review`: foi acionado, mas ficou pendurado sem retornar dentro das janelas de espera. A revisão DevOps/Infra foi complementada localmente com as skills `cloud-devops` e `Linux Production Shell Scripts`.
- Validação local principal: Compose renderizado, Caddy validado, scripts shell parseados, lint, typecheck, testes, coverage, Prisma validate e build web.

## Achados altos do reviewer de segurança

### HIGH-1 — endpoints legados públicos de reset bypassavam Turnstile

Evidência original:

- `apps/api/src/settings/settings.controller.ts` expunha `POST /auth/forgot-password` e `POST /auth/reset-password`.
- O fluxo novo protegido está em `POST /auth/password/forgot` e `POST /auth/password/reset`.

Correção aplicada:

- Removidos os endpoints legados públicos do `SettingsController`.
- Mantido apenas o fluxo novo em `AuthController`, que passa por `AbuseProtectionService`.
- Atualizada documentação do web para referenciar `/auth/password/forgot`.

### HIGH-2 — `/metrics` público pela API

Evidência original:

- `apps/api/src/observability/metrics.controller.ts` é `@Public()`.
- `api.DOMINIO.com` fazia proxy de todo tráfego para a API.

Correção aplicada:

- `Caddyfile` agora bloqueia publicamente `/metrics` e `/metrics/*` com `404`.
- O endpoint pode ser inspecionado futuramente via túnel/rede interna, não pela internet pública.

### HIGH-3 — `TURNSTILE_BYPASS_TOKEN` poderia ficar ativo em production

Evidência original:

- `.env.vps.example` permitia `TURNSTILE_BYPASS_TOKEN`.
- O deploy não falhava se o bypass estivesse preenchido.

Correção aplicada:

- `validateEnvironment` agora rejeita `TURNSTILE_BYPASS_TOKEN` em `APP_ENV=production` por padrão.
- `scripts/vps/deploy.sh` falha antes do deploy se o bypass estiver ativo sem `ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION=true`.
- `.env.vps.example` documenta `ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION=false`.
- `README_VPS_DEPLOY.md` deixa claro que bypass só pode existir em janela privada de smoke e deve ser removido antes do go-live.

## Hardening aplicado junto

- `AI_REQUIRED=true` foi explicitado no Compose VPS para API/worker/media-worker.
- `storage.DOMINIO.com` agora recebe os headers básicos de segurança do Caddy.
- `scripts/vps/deploy.sh` valida que `.env.production` não esteja legível por grupo/outros em Linux (`chmod 600` esperado).

## Achados médios remanescentes

Estes não bloqueiam repo-ready, mas devem ser resolvidos antes de operar comercialmente com clientes pagantes:

1. CSP do web ainda está ampla (`connect-src https:` e `unsafe-inline`). Recomenda-se restringir por domínio final após definir `DOMINIO.com`.
2. MinIO CORS usa `AllowedHeaders: ["*"]`. Recomenda-se reduzir após confirmar exatamente os headers do multipart no browser.
3. A app ainda usa credenciais root do MinIO como credenciais S3. Recomenda-se criar usuário/policy MinIO dedicado ao bucket.
4. Backups locais não criptografam dump/bucket por padrão. Antes do go-live, configurar destino externo criptografado e executar restore drill.

## Validações executadas após correções

```bash
bash -n scripts/vps/provision-ubuntu.sh scripts/vps/deploy.sh scripts/vps/smoke.sh scripts/vps/backup.sh scripts/vps/rollback.sh
docker compose --env-file /tmp/clipbr-vps-review.env -f docker-compose.vps.yml config --quiet
docker run --rm -e APP_DOMAIN=example.com -e CADDY_EMAIL=admin@example.com \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile
npm run lint
npm run typecheck
npm test --workspace @clipbr/api -- --run src/config/env.spec.ts src/auth/auth-commercial.spec.ts
npm test
npm run test:coverage
npm run db:validate
npm run build --workspace @clipbr/web
```

Resultados:

- Shell scripts: PASS.
- Compose VPS config: PASS.
- Caddyfile: PASS.
- Lint: PASS.
- Typecheck API + web: PASS.
- Testes unitários/integrados locais: PASS, 79 testes.
- Coverage API: PASS, 78.69% statements, 62.39% branches, 79.38% functions, 82.33% lines.
- Prisma validate: PASS.
- Web production build: PASS.

## Veredito

**PASS para repo-ready/deploy controlado em VPS.**

**PENDENTE para produção comercial live** até:

- domínio final e TLS estarem ativos;
- `.env.production` real sem placeholders e sem bypass Turnstile;
- Mercado Pago, Resend e Turnstile reais passarem;
- smoke externo e 5 GiB passarem na VPS;
- backup externo criptografado e restore drill passarem;
- soak 24h passar sem restart/OOM/DLQ/outbox pendente.
