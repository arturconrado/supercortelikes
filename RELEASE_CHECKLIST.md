# Checklist de go-live da demo

## Gate do repositório

- [x] Configuração canônica e aliases temporários documentados.
- [x] Refresh token protegido por HMAC com segredo independente.
- [x] API readiness verifica PostgreSQL, Redis, R2, relay e oito filas.
- [x] Upload direto multipart tenant-scoped, idempotente, retomável e abortável.
- [x] Frontend usa concorrência 2, três tentativas, progresso e `sessionStorage`.
- [x] Bundle Render contém Node 22, Python 3.11, FFmpeg, IA e watchdog.
- [x] Worker pesado limitado globalmente a um job.
- [x] Compose local-lite, local-full e release externo renderizam.
- [x] Blueprint Render, configuração Vercel e workflow reutilizável adicionados.
- [x] Gate de cobertura mínimo 60% por métrica.
- [x] Gate E2E completo do novo `local-full` executado em runner limpo.
- [x] Regressão multipart de 5 GiB executada contra R2/MinIO.

## Provisionamento assistido

- [ ] Neon pooled/direct criados em Virginia e migration aplicada.
- [ ] Render Blueprint criado; API Starter, worker Standard e KV Starter ativos.
- [ ] Disco de 25 GB montado em `/data` no worker.
- [ ] R2 privado criado; CORS e lifecycle aplicados por `npm run infra:r2`.
- [ ] Vercel Root Directory `apps/web`; arquivos externos habilitados.
- [ ] `NEXT_PUBLIC_API_URL` aponta para o domínio estável da API.
- [ ] Secrets/variables do environment `demo-production` configurados.
- [ ] Branch protection exige o release gate.
- [ ] `DEMO_DEPLOY_ENABLED=true` somente após todos os itens anteriores.

## Evidência de go-live

- [ ] `/health/ready` responde 200 e `/health/live` reporta o SHA implantado.
- [ ] Register/login/projeto/upload multipart/processamento/export/download passam.
- [ ] Objeto fonte, captions e export existem no R2 privado.
- [ ] Export é H.264, 1080×1920 e validado por `ffprobe`.
- [ ] DLQ aberta = 0 e outbox não publicada = 0.
- [ ] API e worker permanecem dez minutos sem restart.
- [ ] Rollback do SHA anterior foi ensaiado ou documentado com responsáveis.

Enquanto os itens de provisionamento e evidência não estiverem marcados, o estado é **repo-ready; demo live pendente**, não produção recuperada.
