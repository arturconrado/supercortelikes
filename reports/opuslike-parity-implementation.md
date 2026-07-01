# ClipBR AI — avanço de paridade funcional Opus-like

Data: 2026-07-01

## Resultado

Implementado o pacote de paridade visual/operacional solicitado:

- thumbnail real de vídeo gerada pelo media-worker e persistida no storage;
- thumbnail real por corte candidato, baseada no frame inicial do corte;
- URLs assinadas para thumbnails, preview/render e captions nos endpoints de vídeo/cortes;
- preview de corte em modal na tela do vídeo;
- editor básico de corte com timing, formato, estilo de legenda, SEO e export;
- logo real do Brand Kit materializado pela API/Node worker e aplicado pelo media-worker no render via overlay;
- fallback de watermark textual quando logo não estiver disponível;
- detecção heurística de legenda hard-coded usando OpenCV quando disponível;
- cues reais de legenda persistidas no banco;
- E2E browser real com Playwright cobrindo cadastro, import por URL, redirecionamento para vídeo, preview e editor;
- gate local-full AI explícito em `npm run gate:local-full-ai`.

## Arquivos principais alterados

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260701002000_thumbnails_caption_styles/migration.sql`
- `apps/api/src/media/media-stage.processor.ts`
- `apps/api/src/content/content.controller.ts`
- `apps/api/src/analytics/analytics.controller.ts`
- `services/media-worker/src/media_worker/media.py`
- `services/media-worker/src/media_worker/pipeline.py`
- `services/media-worker/src/media_worker/rendering.py`
- `services/media-worker/src/media_worker/captions.py`
- `apps/web/components/clip-card.tsx`
- `apps/web/app/(platform)/library/[id]/page.tsx`
- `apps/web/app/(platform)/clips/[id]/page.tsx`
- `apps/web/e2e/product-smoke.spec.ts`
- `apps/web/playwright.config.ts`
- `scripts/acceptance/local-full-ai-gate.sh`

## Validação executada

Passou:

```bash
npm run db:generate
npm run typecheck
npm test
npm run test:e2e:web
npm run lint
npm run db:validate
npm run build
PYTHONPATH=services/media-worker/src python3 -m py_compile services/media-worker/src/media_worker/media.py services/media-worker/src/media_worker/pipeline.py services/media-worker/src/media_worker/rendering.py services/media-worker/src/media_worker/captions.py
PYTHONPATH=services/media-worker/src python3 -m pytest services/media-worker/tests/test_captions.py services/media-worker/tests/test_clips.py services/media-worker/tests/test_segmentation.py services/media-worker/tests/test_scoring.py services/media-worker/tests/test_seo.py services/media-worker/tests/test_vision.py
docker compose -f docker-compose.local.yml --profile local-full config --quiet
bash -n scripts/acceptance/local-full-ai-gate.sh
```

Observação: `python3 -m pytest services/media-worker/tests` completo não rodou no Python local porque o ambiente host não tem dependências como `fastapi`, `pydantic` e pacote instalado. Os módulos alterados foram compilados e os testes Python puros passaram.

## Gate AI real

O gate foi implementado como:

```bash
npm run gate:local-full-ai
```

Ele sobe:

```bash
docker compose -f docker-compose.local.yml -p clipbr-local-full-ai-gate --profile local-full up --build --detach --wait
```

e executa:

```bash
node scripts/acceptance/product-e2e.mjs
```

com `local-full`, upload direto, worker Node e media-worker AI real.

## Pendências conhecidas

- Rodar o gate `local-full` completo com imagem AI real no ambiente de máquina com memória suficiente.
- Rodar pytest completo dentro da imagem/container do media-worker para validar dependências FastAPI/Pydantic/IA.
- Evoluir o editor de legenda de “estilo/template + cues persistidas” para edição palavra-a-palavra com re-render fiel por clip.
