# Relatório — VPS Produção Rápida ClipBR/Supercorteslikes

Data: 2026-06-27

Status: repo preparado para deploy all-in-one em VPS. Produção comercial ainda não deve ser declarada até domínio, secrets reais, smoke externo, billing/e-mail/Turnstile reais, backup/restore e soak 24h passarem.

## Implementado

- Stack VPS em `docker-compose.vps.yml` com Caddy, web, API, worker Node, media-worker AI, PostgreSQL, Redis, MinIO, migrate, minio-init e backup opcional.
- Proxy público em `Caddyfile`:
  - `https://DOMINIO.com` → web;
  - `https://api.DOMINIO.com` → API;
  - `https://storage.DOMINIO.com` → MinIO S3 API.
- `.env.vps.example` com domínio, URLs públicas, secrets, MinIO, Mercado Pago, Resend, Turnstile, IA CPU/int8/tiny e limites de upload.
- Scripts VPS:
  - `scripts/vps/preflight.sh`;
  - `scripts/vps/provision-ubuntu.sh`;
  - `scripts/vps/deploy.sh`;
  - `scripts/vps/smoke.sh`;
  - `scripts/vps/backup.sh`;
  - `scripts/vps/rollback.sh`.
- Documentação operacional em `README_VPS_DEPLOY.md` e ponteiro em `README_DEPLOY.md`.
- Web ajustado para produção com Turnstile no cadastro e no reset de senha, além da correção do endpoint de reset para `/auth/password/forgot`.
- Dockerfile web recebe `NEXT_PUBLIC_TURNSTILE_SITE_KEY` no build.
- Postgres exposto somente em `127.0.0.1:55432` para o smoke consultar estado final sem abrir banco publicamente.
- `/metrics` bloqueado publicamente no Caddy; use túnel/rede interna se precisar coletar métricas.
- `TURNSTILE_BYPASS_TOKEN` bloqueado por padrão em `APP_ENV=production`.
- Gate 5 GiB ajustado para usar conta/JWT verificado em produção.
- Código legado de reset de senha removido de `SettingsService`; o fluxo público fica centralizado em `/auth/password/forgot` e `/auth/password/reset`, com Turnstile.
- Runbook atualizado para VPS econômica 4 vCPU / 8 GB RAM, com DigitalOcean suportado e Hetzner como alternativa barata recomendada.
- Decisão de arquitetura documentada: VPS + Docker Compose para o primeiro lançamento; GPU VPS se IA local pesada; storage S3-compatible externo como hardening recomendado quando o volume crescer.
- `VPS_PROVIDER` adicionado ao `.env.vps.example` e ao `preflight` para suportar `digitalocean`, `hetzner`, `ovh`, `vultr`, `akamai` ou `generic`.

## Validações executadas

```bash
bash -n scripts/vps/preflight.sh scripts/vps/provision-ubuntu.sh scripts/vps/deploy.sh scripts/vps/smoke.sh scripts/vps/backup.sh scripts/vps/rollback.sh
node --check scripts/acceptance/product-e2e.mjs
node --check scripts/acceptance/direct-upload-5g.mjs
docker compose --env-file /tmp/clipbr-vps.env -f docker-compose.vps.yml config --quiet
docker run --rm -e APP_DOMAIN=example.com -e CADDY_EMAIL=admin@example.com -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run db:validate
npm run build --workspace @clipbr/web
```

Resultados:

- Lint: PASS.
- Typecheck API + web: PASS.
- Testes API + web: PASS, 79 testes no total.
- Coverage API: PASS, 78.69% statements, 62.39% branches, 79.38% functions, 82.33% lines.
- Prisma validate: PASS.
- Web production build: PASS.
- Compose VPS config: PASS.
- Caddyfile validate: PASS.

## Revisão com agentes

Foi executada uma revisão com agentes especializados após a primeira preparação da VPS.

### Security reviewer

Veredito inicial do agente: FAIL para produção pública por três achados altos.

Achados e resolução:

- Reset de senha legado sem Turnstile: resolvido removendo o código legado de `SettingsService`; rotas públicas de reset ficam no `AuthController`.
- `/metrics` público: resolvido no `Caddyfile` com bloqueio público de `/metrics`.
- `TURNSTILE_BYPASS_TOKEN` em produção: resolvido com validação de ambiente que rejeita bypass em `APP_ENV=production` salvo `ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION=true`, e documentação exigindo remoção antes do go-live.

Achados médios ainda recomendados para hardening:

- reduzir CSP do web para origens finais;
- reduzir `AllowedHeaders` do CORS MinIO após confirmar todos os headers S3 usados no E2E;
- criar usuário/policy MinIO dedicada ao bucket em vez de usar credencial root da aplicação;
- ativar backup externo criptografado e executar restore drill.
- migrar storage persistente de mídia para DigitalOcean Spaces quando sair do primeiro go-live controlado.

### QA/E2E reviewer local

Achado: o gate 5 GiB isolado criava usuário novo se nenhum token fosse informado, o que falharia em produção com e-mail verificado obrigatório.

Resolução: `scripts/acceptance/direct-upload-5g.mjs` agora aceita `ACCEPTANCE_EMAIL`/`ACCEPTANCE_PASSWORD` ou `ACCEPTANCE_ACCESS_TOKEN`; `scripts/vps/smoke.sh` repassa a conta verificada de smoke para o gate 5 GiB.

## Pendências antes de abrir para clientes

- Definir domínio final e apontar DNS:
  - `DOMINIO.com`;
  - `api.DOMINIO.com`;
  - `storage.DOMINIO.com` em DNS-only se usar Cloudflare.
- Provisionar VPS Ubuntu 24.04 no perfil econômico, preencher `.env.production` sem placeholders e usar `VPS_SIZE_PROFILE=budget`; se for Hetzner, usar também `VPS_PROVIDER=hetzner`.
- Configurar Mercado Pago, Resend e Cloudflare Turnstile reais.
- Rodar `npm run vps:deploy` na VPS.
- Criar/verificar uma conta de smoke e rodar:

```bash
export PRODUCT_E2E_EMAIL=smoke@DOMINIO.com
export PRODUCT_E2E_PASSWORD='SenhaForte123!'
npm run vps:smoke
RUN_5G=true npm run vps:smoke
```

- Validar webhook Mercado Pago em `https://api.DOMINIO.com/api/mercado-pago/webhook`.
- Configurar backup diário e executar restore drill em VPS separada.
- Rodar soak de 24h antes de declarar GA comercial.

## Veredito

Repo-ready para deploy rápido em VPS: PASS.

Produção comercial/GA: PENDENTE até smoke externo, integrações reais, backup/restore e soak 24h passarem.
