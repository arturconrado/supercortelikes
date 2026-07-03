# Validação de produção — PicaShorts

Data: 2026-07-03 14:06 UTC  
Ambiente: produção DigitalOcean VPS  
Web: https://picashorts.com  
API: https://api.picashorts.com  
Storage: https://storage.picashorts.com  

## Resultado executivo

Status: ⚠️ PARCIALMENTE APROVADO

A produção está operacional para o fluxo principal via upload direto:

- Login com conta smoke verificada: PASS
- Projeto: PASS
- Upload direto multipart: PASS
- Ingestão: PASS
- Transcrição: PASS
- Segmentação: PASS
- Viral score: PASS
- Criação de corte: PASS
- Legendas: PASS
- Render: PASS
- Export/download: PASS
- MP4 final H.264 1080x1920: PASS

Bloqueador remanescente:

- Pipeline global está `degraded` por DLQs abertas de importação YouTube (`URL_IMPORT_AUTH_REQUIRED`).
- Cookies do YouTube ainda não estão configurados na VPS.
- LLM externo está desabilitado no media-worker (`llm_provider=none`), portanto scoring/SEO usa fallback/local.

## Saúde externa

`GET https://api.picashorts.com/health/ready`

```json
{
  "status": "ok",
  "build": "60a59619f3fe8f59ab76a5b818669a3649346161",
  "database": "up",
  "redis": "up",
  "storage": "up",
  "outboxRelay": "up",
  "queues": "registered",
  "configuration": "valid"
}
```

`GET https://api.picashorts.com/health/pipeline`

```json
{
  "status": "degraded",
  "outbox": {
    "relay": "up",
    "unpublished": 0,
    "oldestAgeMs": 0
  },
  "deadLettersOpen": 4
}
```

Web:

- `https://picashorts.com/login?next=%2Fdashboard`: HTTP 200
- `https://picashorts.com/`: HTTP 307 para `/dashboard`
- CSP e headers básicos de segurança presentes.

Storage:

- `https://storage.picashorts.com/minio/health/live`: HTTP 200

## Containers

Todos os containers principais estavam sem restart:

```text
/clipbr-vps-api-1 restart=0 status=running health=healthy
/clipbr-vps-worker-1 restart=0 status=running health=healthy
/clipbr-vps-media-worker-1 restart=0 status=running health=healthy
/clipbr-vps-web-1 restart=0 status=running health=healthy
/clipbr-vps-postgres-1 restart=0 status=running health=healthy
/clipbr-vps-redis-1 restart=0 status=running health=healthy
/clipbr-vps-minio-1 restart=0 status=running health=healthy
/clipbr-vps-caddy-1 restart=0 status=running health=none
```

## E2E de produto

Comando executado localmente com túnel SSH para Postgres da VPS:

```bash
npm run acceptance:product
```

Configuração usada:

- `PRODUCT_E2E_API_URL=https://api.picashorts.com`
- `PRODUCT_E2E_WEB_URL=https://picashorts.com`
- Conta smoke verificada criada diretamente no banco
- Vídeo fixture gerado no `media-worker` da VPS
- `PRODUCT_E2E_SKIP_FFPROBE=true` no script, seguido de `ffprobe` manual no container

Resultado do script:

```text
Error: Global DLQ is not empty: 4
```

Interpretação: o fluxo funcional novo passou até o fim; a falha ocorreu no gate global final por DLQs abertas preexistentes/externas de YouTube.

## Evidência do vídeo E2E criado

Vídeo:

```text
videoId=06a52f68-e8db-413c-a883-60cea265d70b
pipelineRunId=428189b5-63d6-4862-bd00-a40bd10990f6
status=UPLOADED
durationMs=6461
source=upload direto
thumbnailKey=thumbnails/videos/06a52f68-e8db-413c-a883-60cea265d70b/source.jpg
```

Pipeline do vídeo:

```text
INGESTION      SUCCEEDED attempts=1
TRANSCRIPTION  SUCCEEDED attempts=1
SEGMENTATION   SUCCEEDED attempts=1
SCORING        SUCCEEDED attempts=1
CLIPS          SUCCEEDED attempts=1
CAPTIONS       SUCCEEDED attempts=1
RENDERING      SUCCEEDED attempts=1
EXPORTS        SUCCEEDED attempts=1
```

Persistência:

```text
transcript language=en confidence=0.46142 chars=130 words=26
segments=1
viralScores=1
clips=1
captions=1
readyExports=1
processing.minutes recorded=0.1077
```

Export:

```text
exportId=62cd547c-3b2f-4903-9da4-a07dd4a2db7e
storageKey=exports/06a52f68-e8db-413c-a883-60cea265d70b/clip-001.mp4
sizeBytes=1464564
```

`ffprobe` do MP4 final:

```json
{
  "streams": [
    {
      "codec_name": "h264",
      "width": 1080,
      "height": 1920,
      "duration": "6.120000"
    }
  ]
}
```

## DLQs abertas

Todas as DLQs abertas são de importação YouTube:

```text
URL_IMPORT_AUTH_REQUIRED https://www.youtube.com/watch?v=NX3vAWDAp8Q attempts=1
URL_IMPORT_AUTH_REQUIRED https://www.youtube.com/watch?v=NX3vAWDAp8Q attempts=1
URL_IMPORT_AUTH_REQUIRED https://www.youtube.com/watch?v=fff7VvFggBc attempts=1
URL_IMPORT_AUTH_REQUIRED https://www.youtube.com/watch?v=qHlquy4-YEs attempts=5
```

Observação:

- O hotfix de fail-fast está funcionando para os jobs novos: `attempts=1`.
- O item com `attempts=5` é anterior ao fail-fast.
- Nenhum DLQ aberto pertence ao vídeo novo validado por upload direto.

## Estado YouTube/cookies

Media-worker:

```text
llm_provider=none
llm_key_set=false
cookies_configured=false
enable_ai=true
whisperx=true
opencv=true
mediapipe=true
yolo=true
```

Conclusão:

- YouTube por URL ainda não pode ser considerado validado em produção.
- É necessário subir `youtube-cookies.txt` real com `scripts/vps/configure-youtube-cookies.sh`.
- Se cookies não forem suficientes, configurar `YTDLP_PROXY` com proxy residencial/ISP.

## Pendências para produção verde

1. Configurar cookies reais do YouTube na VPS.
2. Redrivar ou descartar DLQs antigas de YouTube depois de decidir a política operacional.
3. Reexecutar `npm run acceptance:product` com DLQ global zerada.
4. Configurar `LLM_API_KEY`/OpenRouter em produção se scoring/SEO por LLM for obrigatório.
5. Rodar soak de 10 minutos/24h conforme critério comercial.

## Veredito

Produção está apta para validação manual do fluxo por upload direto e exportação.

Ainda não está 100% verde para go-live completo enquanto o import por YouTube estiver sem cookies e o pipeline global permanecer `degraded`.
