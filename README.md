# PicaShorts

Plataforma SaaS para transformar vídeos longos em cortes verticais prontos para publicação.

## Desenvolvimento local

Requisitos: Node.js 22+, npm 11.12+ e Docker com Compose.

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml --profile local-lite up -d --build
```

A API fica disponível em `http://localhost:3001`, com health check em
`http://localhost:3001/health/live` e readiness em
`http://localhost:3001/health/ready`.

O perfil `local-lite` não executa IA. `local-full` executa o fluxo completo com
multipart direto e IA. O gate autocontido legado da release continua disponível e usa a stack
completa, WhisperX `tiny`, CPU/int8 e diarização desabilitada:

```bash
docker compose -p clipbr-release-gate --profile release up -d --build
```

O perfil `production` exige PostgreSQL, Redis, storage S3/R2 e segredos externos;
consulte `.env.example` para as variáveis `PRODUCTION_*` obrigatórias.

## Verificação

```bash
npm test
npm run test:coverage
npm run lint
npm run typecheck
npm run build
```

Em cloud, o navegador usa os contratos multipart `/videos/presigned-upload`,
`/videos/:id/upload-parts` e `/videos/confirm-upload`; o corpo não atravessa a API.
`POST /videos/upload` permanece apenas para compatibilidade local em `UPLOAD_MODE=stream`.

Consulte [README_DEPLOY.md](README_DEPLOY.md), [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)
e [reports/demo-option-a.md](reports/demo-option-a.md) para provisionamento e evidências.
