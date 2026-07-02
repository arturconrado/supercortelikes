# PicaShorts Web

Frontend Next.js do PicaShorts. Configure `NEXT_PUBLIC_API_URL` com a origem pública da API; em desenvolvimento, o valor esperado é `http://localhost:3001`.

## Executar

```bash
npm install --workspaces=false
npm run dev --workspaces=false
```

## Contratos consumidos

Todas as rotas autenticadas recebem `Authorization: Bearer <token>`. Respostas de coleção podem ser um array ou usar os envelopes `data`, `items` ou `results`.

- `POST /auth/login`, `POST /auth/register`, `POST /auth/password/forgot`, `PATCH /auth/password` e `GET /auth/me`
- `GET /analytics/overview` e `GET /analytics?period=30d`
- `GET /videos`, `GET /videos/:id`, `POST /videos/import` e `POST /videos/upload`
- `GET|POST /projects`, `GET /projects/:id` e `POST /projects/:id/process`
- `GET /clips/:id` e `PATCH /clips/:id`
- `GET|POST /exports`, `POST /exports/:id/retry` e `DELETE /exports/:id`
- `GET /billing/plans`, `GET /billing/subscription` e `POST /billing/checkout`
- `PATCH /users/me`, `GET|PUT /users/me/notifications` e `GET|PUT /brand-kits`

O upload usa `multipart/form-data` no campo `file`, envia `Idempotency-Key` e exibe progresso real via `XMLHttpRequest`. A API deve aceitar a origem do frontend em CORS e expor URLs assinadas para preview e download nos campos usados pelas entidades.
