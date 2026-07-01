# Runbook — filas, DLQ e worker

## Sintomas

- `/health/pipeline` retorna `degraded`.
- `deadLettersOpen > 0`.
- Outbox pendente com idade maior que 5 minutos.
- Worker sem heartbeat ou media-worker not-ready.

## Ações

1. Inspecionar o workspace/cliente:
   `node scripts/support/inspect-customer.mjs <email|workspace-id>`
2. Verificar logs do worker Render e uso do disco `/data`.
3. Se a falha for transitória e o input for válido:
   `node scripts/support/redrive-dlq.mjs <dead-letter-id>`
4. Se o job estiver travado por pedido do cliente ou abuso:
   `node scripts/support/cancel-pipeline.mjs <pipeline-run-id>`
5. Limpar uploads órfãos expirados:
   `ORPHAN_UPLOAD_HOURS=48 node scripts/support/cleanup-orphan-uploads.mjs`

## Critérios de recuperação

- DLQ aberta = 0 ou cada item tem decisão registrada.
- Outbox pendente < 5 min.
- API e worker healthy.
- Novo fluxo completo passa.
