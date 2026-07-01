# Relatório — Paridade funcional Opus-like

Data: 2026-07-01

## Status

✅ Rodada implementada e validada localmente.

Esta rodada melhora o fluxo principal de produto:

1. importar/enviar vídeo;
2. cair na tela correta do vídeo;
3. acompanhar pipeline;
4. ver vídeos recentes no dashboard;
5. renomear vídeo;
6. preservar/exibir título real quando `yt-dlp` fornece metadados;
7. configurar Brand Kit MVP com texto, cores, fonte, logoKey, posição e opacidade;
8. aceitar WEBM de forma consistente nos Compose local/release/VPS.

Ainda não é paridade total com OpusClip porque seguem pendentes recursos Pro/Business e alguns MVPs visuais citados abaixo.

## Arquivos principais alterados

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260701001000_video_editable_title/migration.sql`
- `apps/api/src/videos/*`
- `apps/api/src/media/media-stage.processor.ts`
- `apps/api/src/analytics/analytics.controller.ts`
- `apps/api/src/settings/settings.service.ts`
- `apps/web/app/(platform)/library/[id]/page.tsx`
- `apps/web/app/(platform)/library/page.tsx`
- `apps/web/app/(platform)/dashboard/page.tsx`
- `apps/web/app/(platform)/settings/page.tsx`
- `services/media-worker/src/media_worker/media.py`
- `services/media-worker/src/media_worker/pipeline.py`
- `docker-compose.local.yml`
- `docker-compose.release.yml`
- `docker-compose.vps.yml`

## Correções aplicadas

- Adicionado `Video.title` editável e backfill por migration.
- Criado `PATCH /videos/:id` para renomear vídeos por workspace.
- Upload/import passam a criar título inicial amigável.
- Worker salva `source.metadata.json` com `yt-dlp` e o estágio de ingestão propaga `source.title`.
- API atualiza o título do vídeo quando o worker descobre título real da fonte.
- Biblioteca sempre abre `/library/:videoId`, mesmo quando o vídeo pertence a um projeto.
- Página do vídeo ganhou edição inline de título.
- Dashboard agora recebe/renderiza `recentVideos` e `recentProjects`.
- Brand Kit preserva posição/opacidade e permite limpar texto da marca d’água.
- Settings ganhou controles de logoKey, fonte, cores, posição e opacidade.
- Compose local/release/VPS agora aceitam `video/webm`.

## Validações executadas

```bash
npm run db:generate --workspace @clipbr/api
npm run db:validate --workspace @clipbr/api
npm run typecheck
npm run lint
npm test
npm run test:coverage
cd services/media-worker && PYTHONPATH=src .venv/bin/pytest -q
npm run build
docker compose -f docker-compose.local.yml --profile local-lite config
docker compose -f docker-compose.release.yml --profile release config
docker compose -f docker-compose.vps.yml config
PORT=53101 WEB_PORT=53100 POSTGRES_PORT=55433 REDIS_PORT=56380 MINIO_API_PORT=59002 MINIO_CONSOLE_PORT=59003 S3_PUBLIC_ENDPOINT=http://localhost:59002 NEXT_PUBLIC_API_URL=http://localhost:53101 PUBLIC_API_URL=http://localhost:53101 PUBLIC_APP_URL=http://localhost:53100 CORS_ORIGIN=http://localhost:53100 docker compose -f docker-compose.local.yml -p clipbr-option-a-gate --profile local-lite up --build --detach --wait
curl -fsS http://localhost:53101/health/ready
curl -fsS -I http://localhost:53100
```

Resultado:

- API tests: 85 passed.
- Web tests: 17 passed.
- Media-worker tests: 32 passed.
- API coverage: statements 82.4%, branches 63.28%, functions 83.08%, lines 86.17%.
- Build API/Web: PASS.
- Compose local-lite atualizado: API, web, Postgres, Redis, MinIO e media-worker-lite healthy.
- API ready local: `status=ok`, database/redis/storage/outbox/queues/config ok.

## Gaps remanescentes para paridade total

### MVP ainda incompleto

- Thumbnail real do vídeo fonte: UI já suporta, mas falta gerar/persistir/expor `thumbnailUrl`.
- Preview inline dos cortes em modal/painel lateral.
- Editor visual de legenda/estilo; hoje existe edição de metadata e endpoint de captions.
- Logo real aplicado no render; hoje o render aplica watermark textual.
- Detecção de legenda hard-coded no vídeo original.
- Export filename baseado no título do clipe.
- Acceptance real para import YouTube/Loom/Drive com worker full AI nesta rodada não foi executado.

### Pro/Business fora desta rodada

- OAuth Zoom/Meet/social.
- Agendamento/publicação real.
- B-roll, editor avançado, timeline drag, filler removal visual.
- ClipAnything multimodal.
- Rearranjo de segmentos não-contíguos.
- Webhooks Business/API parceiros completa.

## Próximo passo recomendado

Rodar o gate pesado com `local-full` e depois implementar os dois MVPs mais visíveis:

1. thumbnail real em ingestão/export;
2. preview inline/modal de cortes.

Depois disso, rodar `acceptance:product` completo com worker full AI e um link real suportado.
