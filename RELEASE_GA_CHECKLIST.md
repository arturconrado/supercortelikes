# Checklist GA comercial v1

## Produto e contratos

- [x] Planos públicos retornam versão, preço, features e limites.
- [x] Cadastro exige versão de Termos e Privacidade.
- [x] Upload direto aplica limite de plano e quota mensal.
- [x] Pipeline registra minutos processados de forma idempotente.
- [x] Billing checkout e webhook são idempotentes.
- [x] Páginas de Termos, Privacidade e Reembolso existem.
- [x] Suíte `npm run acceptance:product` cobre o E2E principal: auth/legal, billing/usage, upload direto, pipeline, clips, exportação e download.

## Operação comercial

- [ ] Domínio final configurado.
- [ ] Neon backup ativo e restore drill executado.
- [ ] R2 privado com CORS/lifecycle validado.
- [ ] Mercado Pago live/sandbox-live validado com webhook real.
- [ ] Resend entregando verificação/reset.
- [ ] Turnstile habilitado em produção.
- [ ] Dashboards e alertas externos ativos.
- [ ] Runbooks testados por outra pessoa.
- [ ] Soak 24h com synthetic checks.

## Critério de lançamento

Só declarar GA comercial quando todos os itens operacionais estiverem concluídos e o gate externo real passar sem DLQ aberta, outbox atrasada ou restart/OOM.
