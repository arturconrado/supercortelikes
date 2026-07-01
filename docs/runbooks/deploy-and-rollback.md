# Runbook — deploy e rollback GA v1

## Deploy

1. Manter `DEMO_DEPLOY_ENABLED=false`.
2. Rodar o gate completo em `main`.
3. Confirmar secrets de Render, Vercel, Neon, R2, Mercado Pago, Resend e Turnstile.
4. Habilitar `DEMO_DEPLOY_ENABLED=true` no environment `demo-production`.
5. Promover o SHA aprovado via GitHub Actions.
6. Conferir `/health/live`, `/health/ready`, `/health/pipeline`, web pública e smoke externo.
7. Executar um fluxo real: cadastro, verificação de e-mail, plano, upload, processamento, export e download.
8. Observar por 24h antes de declarar GA.

## Rollback

1. Desabilitar `DEMO_DEPLOY_ENABLED`.
2. Reverter API e worker Render para o mesmo SHA anterior.
3. Rodar rollback Vercel para o deployment anterior compatível.
4. Não reverter migrations destrutivamente; usar código compatível com schema atual.
5. Validar `/health/ready`, DLQ aberta, outbox pendente e download de export existente.
