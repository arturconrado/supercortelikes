# Runbook — billing, suporte e abuso

## Billing

- Webhooks do Mercado Pago são idempotentes por `type:dataId`.
- Checkout exige `Idempotency-Key`.
- Assinatura `PAST_DUE`, `CANCELLED` ou `EXPIRED` cai para bloqueio após o período de graça.
- Nunca alterar plano manualmente sem registrar motivo em ticket interno.

## Suporte

1. Confirmar identidade do usuário pelo e-mail da conta.
2. Inspecionar workspace com `inspect-customer`.
3. Para problema de quota, conferir `processing.minutes` do mês corrente.
4. Para reembolso, aplicar a política publicada em `/refunds`.

## Abuso

- Conteúdo ilegal, sem direito autoral ou abuso de upload deve ter processamento cancelado.
- Se houver risco de cobrança/fraude, cancelar pipeline, manter evidência e bloquear novos processamentos pelo plano/status.
