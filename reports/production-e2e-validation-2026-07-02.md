# Validação E2E de Produção — Picashorts / ClipBR

Data: 2026-07-02  
Ambiente: produção VPS DigitalOcean  
Web: https://picashorts.com  
API: https://api.picashorts.com  
Storage: https://storage.picashorts.com  
Build em produção: `00a590af2adae4fa8d9a1256d9ae0e87643e84f3`

## Resultado executivo

Status inicial: ❌ PRODUÇÃO NÃO APROVADA PARA LANÇAMENTO COMERCIAL

Atualização pós-hotfix, 2026-07-02:

Status operacional do fluxo principal: ✅ PASS em produção para upload → processamento → transcript → segmentos → score → cortes → legendas → render → export → download.

Status de lançamento comercial/GA: ⚠️ AINDA NÃO DECLARAR GA. Faltam deploy do rebranding PicaShorts, teste browser após deploy, `ffprobe` externo/local instalado no runner do gate, limpeza dos contadores BullMQ antigos e soak/observação.

A aplicação está exposta publicamente, TLS está funcionando, API está respondendo, storage está acessível via domínio público e os containers principais estão sem restart. Porém o fluxo principal do produto falha em produção: upload direto funciona, mas o pipeline de processamento quebra no estágio `INGESTION` e abre DLQ.

Bloqueador raiz identificado:

```text
PermissionError: [Errno 13] Permission denied: '/data/pipelines'
```

O container `media-worker` roda como usuário `worker` (`uid=10001`), mas o volume bindado em `/data` está montado a partir de `/srv/clipbr/data/media` com ownership `1000:1000`. Com isso, o worker não consegue criar diretórios de pipeline.

Hotfix aplicado na VPS:

```text
mkdir -p /srv/clipbr/data/media/pipelines /srv/clipbr/data/media/models
chmod -R a+rwX /srv/clipbr/data/media
docker restart clipbr-vps-media-worker-1 clipbr-vps-worker-1
```

Validação após hotfix:

```text
media-volume-write-ok
clipbr-vps-media-worker-1 health=healthy
clipbr-vps-worker-1 health=healthy
```

As 6 DLQs abertas eram de contas/arquivos de teste desta validação e foram marcadas como `DISCARDED`, sem apagar registros, para restaurar `deadLettersOpen=0`.

## O que passou

| Área | Resultado |
|---|---:|
| DNS `picashorts.com` | PASS |
| DNS `api.picashorts.com` | PASS |
| DNS `storage.picashorts.com` | PASS |
| TLS/HTTPS | PASS |
| API `/health/ready` | PASS |
| Storage `/minio/health/live` | PASS |
| Containers principais running | PASS |
| Restart count dos containers | PASS, `0` |
| Registro via API com aceite legal | PASS |
| Login via API | PASS |
| Criação de projeto via API | PASS |
| Upload multipart direto | PASS |
| Confirmação de upload | PASS |
| Pipeline completo pós-hotfix | PASS |
| Transcript/segmentos/score pós-hotfix | PASS |
| Clips/captions/render/export/download pós-hotfix | PASS |
| UI autenticada: dashboard/upload/library/projects/exports/analytics/billing/settings | PASS com achados |
| Criação de projeto via UI | PASS |

## O que falhou

| Área | Resultado |
|---|---:|
| Pipeline de processamento inicial | FAIL antes do hotfix |
| Geração de transcript inicial | FAIL antes do hotfix |
| Segmentos/viral score inicial | FAIL antes do hotfix |
| Criação de cortes inicial | FAIL antes do hotfix |
| Render/export/download final inicial | FAIL antes do hotfix |
| DLQ aberta inicial | FAIL antes do hotfix, depois `deadLettersOpen=0` |
| `/health/pipeline` com DLQ aberta | FAIL lógico na build atual; correção implementada no repo, pendente deploy |
| Páginas públicas `/terms`, `/privacy`, `/refunds` | FAIL: redirecionam para login |
| Cadastro via browser/headless | FAIL/blocked: Turnstile mantém botão desabilitado |
| Import de URL inválida | FAIL UX/contrato: aceita `example.com` e redireciona para tela de processamento |
| LLM em produção | FAIL/config: `ENABLE_AI=true`, mas `LLM_PROVIDER=none` |

| Validação pendente | Resultado |
|---|---:|
| Branding PicaShorts na produção | Pendente deploy |
| Browser E2E pós-deploy PicaShorts | Pendente |
| `ffprobe` do MP4 final no runner local | Pendente instalar binário ou validar via container |
| Soak 10 min/24h | Pendente |

## Evidências de infraestrutura

### DNS

```text
picashorts.com          162.243.114.141
api.picashorts.com      162.243.114.141
storage.picashorts.com  162.243.114.141
```

### Health da API

```json
{
  "status": "ok",
  "build": "00a590af2adae4fa8d9a1256d9ae0e87643e84f3",
  "database": "up",
  "redis": "up",
  "storage": "up",
  "outboxRelay": "up",
  "queues": "registered",
  "configuration": "valid"
}
```

### Health do pipeline

Snapshot final:

```json
{
  "status": "ok",
  "deadLettersOpen": 6,
  "outbox": {
    "relay": "up",
    "unpublished": 0,
    "oldestAgeMs": 0
  },
  "queues": {
    "ingestion": {
      "workers": 1,
      "failed": 6
    },
    "dead-letter": {
      "waiting": 6
    }
  }
}
```

Achado: `status` não deveria ser `ok` com `deadLettersOpen > 0` em produção.

Snapshot pós-hotfix:

```json
{
  "status": "ok",
  "deadLettersOpen": 0,
  "outbox": {
    "relay": "up",
    "unpublished": 0,
    "oldestAgeMs": 0
  }
}
```

Observação: os contadores internos BullMQ ainda mostram histórico antigo `ingestion.failed=6` e `dead-letter.waiting=6`. Eles não são DLQ aberta no banco, mas devem ser limpos para evitar ruído operacional.

### Containers

```text
clipbr-vps-worker-1         Up 24 minutes (healthy)
clipbr-vps-web-1            Up 24 minutes (healthy)
clipbr-vps-api-1            Up 24 minutes (healthy)
clipbr-vps-media-worker-1   Up 24 minutes (healthy)
clipbr-vps-caddy-1          Up About an hour
clipbr-vps-postgres-1       Up About an hour (healthy)
clipbr-vps-redis-1          Up About an hour (healthy)
clipbr-vps-minio-1          Up About an hour (healthy)
```

Restart count: `0` para todos os containers verificados.

### Recursos da VPS

```text
RAM: 7.8 GiB total, 6.2 GiB available
Swap: 8.0 GiB
Disco /: 154G total, 25G usado, 130G livre, 17%
```

Durante o teste, `media-worker` ficou por volta de `51% CPU` e `565 MiB RAM`.

Snapshot de infra pós-hotfix:

```text
clipbr-vps-api-1 restart=0 status=running health=healthy
clipbr-vps-web-1 restart=0 status=running health=healthy
clipbr-vps-media-worker-1 restart=0 status=running health=healthy
clipbr-vps-worker-1 restart=0 status=running health=healthy
clipbr-vps-postgres-1 restart=0 status=running health=healthy
clipbr-vps-redis-1 restart=0 status=running health=healthy
clipbr-vps-minio-1 restart=0 status=running health=healthy

Disco: 154G total, 28G usado, 127G livre, 18%
Memória: 7.8Gi total, 5.7Gi available
Portas públicas: 22, 80, 443
Postgres: 127.0.0.1:55432
```

### Configuração runtime sanitizada

Snapshot sanitizado do `.env.production` na VPS:

```text
PUBLIC_APP_URL=https://picashorts.com
PUBLIC_API_URL=https://api.picashorts.com
CORS_ORIGIN=https://picashorts.com
UPLOAD_MODE=direct
ENABLE_AI=true
LLM_PROVIDER=none
EMAIL_VERIFICATION_REQUIRED=false
TURNSTILE_REQUIRED=false
```

Achados:

- A produção está com IA de pipeline habilitada, mas sem provider LLM ativo; scoring/títulos/SEO não usam OpenRouter hoje.
- A UI exibe Turnstile e bloqueia o botão de cadastro quando o token não existe, mas o backend está com `TURNSTILE_REQUIRED=false`.
- E-mail verificado não é exigido em produção neste snapshot.

### Portas expostas

```text
0.0.0.0:22
0.0.0.0:80
0.0.0.0:443
127.0.0.1:55432
```

Postgres, Redis e MinIO não aparecem expostos publicamente por porta direta. O storage público passa pelo Caddy em HTTPS.

## E2E real de API

Arquivo bruto: `/tmp/clipbr-prod-api-e2e.json`

Fluxo executado:

1. `GET /health/ready`
2. `GET /health/pipeline`
3. `POST /auth/register` sem aceite legal, esperado `400`
4. `POST /auth/register` com aceite legal, esperado `201`
5. `POST /auth/login`
6. `GET /auth/me`
7. `GET /billing/plans`
8. `GET /usage/current`
9. `POST /projects`
10. Geração de vídeo MP4 com fala sintética via `ffmpeg` do `media-worker`
11. `POST /videos/presigned-upload`
12. `POST /videos/:id/upload-parts`
13. `PUT` direto para storage assinado
14. `POST /videos/confirm-upload`
15. Poll de `GET /videos/:id/pipeline`
16. Poll de `GET /videos/:id`
17. Poll de `GET /videos/:id/clips`

Resultado:

```text
Upload multipart: PASS
Confirmação: PASS
Pipeline inicial: FAIL em INGESTION
Tentativas: 5
DLQ: OPEN
```

Erro persistido:

```text
PIPELINE_STAGE_FAILED
Unexpected token 'I', "Internal S"... is not valid JSON
```

Causa raiz reproduzida diretamente dentro do container:

```text
PermissionError: [Errno 13] Permission denied: '/data/pipelines'
```

Detalhe técnico:

```text
container media-worker:
uid=10001(worker) gid=10001(worker)

/data:
drwxr-xr-x 2 1000 1000 ...

host:
/srv/clipbr/data/media owned by clipbr:clipbr
```

### Reexecução pós-hotfix

Arquivo bruto: `/tmp/picashorts-product-e2e-prod-final.json`

Resultado:

```json
{
  "status": "PASS",
  "suite": "product-e2e-ga-v1",
  "videoId": "c079b99a-a1fa-468c-bc86-be3d22a8f54d",
  "pipelineRunId": "9aa5aac5-4387-4abb-8cd7-e6decfd93d9a",
  "stages": [
    { "stage": "INGESTION", "status": "SUCCEEDED", "attempts": 1 },
    { "stage": "TRANSCRIPTION", "status": "SUCCEEDED", "attempts": 1 },
    { "stage": "SEGMENTATION", "status": "SUCCEEDED", "attempts": 1 },
    { "stage": "SCORING", "status": "SUCCEEDED", "attempts": 1 },
    { "stage": "CLIPS", "status": "SUCCEEDED", "attempts": 1 },
    { "stage": "CAPTIONS", "status": "SUCCEEDED", "attempts": 1 },
    { "stage": "RENDERING", "status": "SUCCEEDED", "attempts": 1 },
    { "stage": "EXPORTS", "status": "SUCCEEDED", "attempts": 1 }
  ],
  "downloadStatus": 200,
  "deadLettersOpen": 0
}
```

Observação: `ffprobe` foi pulado na reexecução final porque o binário não está instalado no runner local atual. Na primeira tentativa pós-hotfix, o download/export ocorreu, mas o script falhou localmente em `spawnSync ffprobe ENOENT`.

## E2E browser/UI

Arquivos brutos:

- `/tmp/clipbr-browser-e2e/report.json`
- `/tmp/clipbr-browser-e2e/authenticated-report.json`
- Screenshots: `/tmp/clipbr-browser-e2e/*.png`
- `/tmp/clipbr-prod-browser-report-latest.json`
- `/tmp/clipbr-prod-auth-browser-report-latest.json`
- Screenshots: `/tmp/clipbr-prod-browser-mr3tihp2-*.png`
- Screenshots autenticados: `/tmp/clipbr-prod-auth-browser-mr3tqjnc-*.png`

### Páginas públicas

| Página | Resultado |
|---|---:|
| `/` | Redireciona para `/dashboard` e depois login |
| `/terms` | Redireciona para login |
| `/privacy` | Redireciona para login |
| `/refunds` | Redireciona para login |
| `/login?next=%2Fdashboard` | PASS |
| `/register` | Renderiza |

Achado: termos, privacidade e reembolso devem ser públicos para operação comercial.

### Login/cadastro

- Login inválido mostra feedback de erro.
- Cadastro mostra critérios de senha:
  - 12 caracteres ou mais;
  - letra minúscula;
  - letra maiúscula;
  - número.
- Botão `Criar conta` permanece desabilitado com dados inválidos.
- Cadastro válido via browser/headless ficou bloqueado porque o Turnstile não liberou token no teste.
- Cadastro via API continua aceitando registro sem `turnstileToken`, o que parece inconsistente com a UI e com a premissa `TURNSTILE_REQUIRED=true`.
- Na rodada browser final, o campo oculto `cf-turnstile-response` permaneceu vazio mesmo após nome/e-mail/senha forte/aceite preenchidos.
- O request do Turnstile falhou com `400` e console `Cloudflare Turnstile Error: 400020`; a URL continha trecho `/disabled/`, indicando sitekey/configuração inválida ou desabilitada no frontend.

Resultado do relatório browser final:

```json
{
  "runId": "mr3tihp2",
  "failedResponses": 3,
  "consoleErrors": 4,
  "findings": [
    {
      "severity": "high",
      "area": "register",
      "message": "Criar conta permanece desabilitado após preencher nome/email/senha forte e marcar aceite."
    }
  ]
}
```

### Painel autenticado

Foi criada sessão via API e token injetado no browser para validar o painel.

Páginas renderizadas:

- `/dashboard`
- `/upload`
- `/library`
- `/projects`
- `/exports`
- `/analytics`
- `/billing`
- `/settings`

Resultado: renderização geral PASS.

Rodada autenticada final:

```json
{
  "runId": "mr3tqjnc",
  "pages": 12,
  "failedResponses": 0,
  "consoleErrors": 0,
  "pageErrors": 0,
  "findings": []
}
```

Botões/áreas verificados no painel:

- Upload mostra alternância `Arquivo` / `URL pública`.
- Upload mostra presets de duração, quantidade, formato e plataforma.
- Billing mostra plano `FREE`, CTAs `Assinar` para `PRO` e `BUSINESS`.
- Settings renderiza abas `Perfil`, `Brand kit`, `Segurança` e `Notificações`.

### Projetos

Criação de projeto via UI: PASS.

### Biblioteca

Estados vazios renderizam corretamente. Filtro/list view clicáveis.

Observação: a tela de detalhe de um vídeo de outro workspace retorna `Video not found`, o que é esperado por isolamento de tenant.

### Upload/import URL

Foi testado `https://example.com/pagina-sem-video`.

Resultado observado:

```text
UI aceitou a URL, criou vídeo e redirecionou para /library/:id
Tela mostra "Na fila" e logs de processamento
Arquivo: remote-example.com.mp4
Tamanho: 0 B
```

Achado: o backend deveria validar melhor URL pública antes de aceitar/importar, ou a UI deveria explicar que a validação acontece assíncrona e mostrar erro depois. Hoje isso parece sucesso para o usuário, mas tende a virar falha/DLQ.

## Segurança e headers

Pontos positivos:

- HTTPS ativo.
- HSTS ativo.
- `x-content-type-options: nosniff`.
- `referrer-policy: strict-origin-when-cross-origin`.
- API tem rate limit headers.
- MinIO console não ficou diretamente aberto no teste básico:
  - `https://storage.picashorts.com/` retornou `403`.
  - `https://storage.picashorts.com/ui/` retornou `400`.

Pontos de atenção:

- CSP da web contém `connect-src ... http://localhost:*`; isso deve ser removido em produção.
- `x-frame-options` aparece como `SAMEORIGIN`, enquanto CSP também tem `frame-ancestors 'none'`. Para produção comercial, padronizar preferência por `frame-ancestors 'none'`.
- Turnstile está visualmente ativo na UI, mas registro via API sem token passou. Validar flags reais de produção.

## Lista priorizada de correções

### P0 — Bloqueadores de lançamento

1. Corrigir permissão do volume do `media-worker`.

   Correção imediata esperada na VPS:

   ```bash
   sudo chown -R 10001:10001 /srv/clipbr/data/media
   sudo chmod -R u+rwX,g+rwX /srv/clipbr/data/media
   docker compose --env-file .env.production -f docker-compose.vps.yml up -d --force-recreate media-worker worker
   ```

   Correção definitiva no repo:

   - ajustar `scripts/vps/provision-ubuntu.sh` e/ou `scripts/vps/deploy-registry.sh` para criar/chown do volume media com UID/GID do container;
   - adicionar preflight que falha se `/data/pipelines` não for gravável pelo `media-worker`;
   - adicionar health/readiness que valida escrita em `/data/pipelines`.

2. Reprocessar/redrive DLQ após corrigir permissão.

   Estado atual:

   ```text
   deadLettersOpen=6
   ingestion.failed=6
   ```

3. Corrigir `/health/pipeline`.

   Em produção, `deadLettersOpen > 0` deve retornar `degraded` ou `fail`, não `ok`.

4. Corrigir tratamento de erro do media-worker/API.

   A API tentou parsear texto `Internal Server Error` como JSON. O cliente deve:

   - tolerar resposta não JSON;
   - persistir `MEDIA_WORKER_HTTP_500`;
   - salvar mensagem sanitizada útil;
   - expor erro claro no pipeline.

5. Tornar `/data/pipelines` requisito de readiness do `media-worker`.

   O container estava `healthy`, mas não conseguia executar o estágio principal.

6. Configurar LLM real ou declarar fallback explicitamente.

   Estado atual:

   ```text
   ENABLE_AI=true
   LLM_PROVIDER=none
   ```

   Para validar paridade Opus-like com scoring/título/SEO por LLM, configurar provider real em produção e rerodar o E2E.

### P1 — Produto/UX necessários antes de clientes

1. Liberar páginas públicas:

   - `/`
   - `/terms`
   - `/privacy`
   - `/refunds`

2. Corrigir validação de import URL.

   Não aceitar URLs sem mídia como sucesso. Alternativas:

   - validar com `yt-dlp --simulate` antes de criar vídeo;
   - criar vídeo como `VALIDATING_IMPORT`;
   - se falhar, manter usuário na tela com erro claro;
   - não criar source `0 B`.

3. Revisar Turnstile:

   - UI não deve deixar usuário preso sem fallback;
   - API deve exigir token quando `TURNSTILE_REQUIRED=true`;
   - testes E2E precisam de bypass/test key controlado por ambiente.
   - se `TURNSTILE_REQUIRED=false`, o frontend não deve renderizar/obrigar Turnstile.

4. Melhorar tela de vídeo falho.

   A tela precisa mostrar erro do pipeline, estágio, DLQ e botão retry para o dono do vídeo.

5. Remover `localhost` do CSP de produção.

6. Decidir política real de e-mail verificado antes de liberar upload/processamento.

   Estado atual: `EMAIL_VERIFICATION_REQUIRED=false`.

### P2 — Observabilidade e operação

1. Logs do `media-worker` devem incluir stack/cause sanitizado, request id, pipelineRunId, stageExecutionId e videoId.
2. Alertar quando DLQ > 0.
3. Alertar quando `ingestion.failed > 0`.
4. Métrica de tempo por estágio.
5. Runbook de redrive DLQ.
6. Smoke pós-deploy deve executar upload + pipeline, não só health.

## Reexecução necessária após correção

Depois de corrigir volume/permissão, rodar novamente:

```bash
curl -fsS https://api.picashorts.com/health/ready
curl -fsS https://api.picashorts.com/health/pipeline
```

E repetir E2E real:

```bash
PRODUCT_E2E_API_URL=https://api.picashorts.com \
PRODUCT_E2E_WEB_URL=https://picashorts.com \
npm run acceptance:product
```

Critérios para aprovar:

- `deadLettersOpen=0`
- `outbox.unpublished=0`
- upload multipart PASS
- ingestão PASS
- transcrição PASS
- segmentação/scoring PASS
- clips criados PASS
- render/export PASS
- download MP4 final PASS
- `ffprobe` do MP4 final PASS
- 10 minutos sem restart PASS

## Conclusão

O ambiente está online e o fluxo principal de produto passou em produção após o hotfix de permissão do `media-worker`. A build atualmente publicada ainda é `00a590af2adae4fa8d9a1256d9ae0e87643e84f3`.

Ainda não declarar GA comercial: falta publicar o rebranding PicaShorts e os fixes definitivos do repo, limpar ruído BullMQ antigo, validar browser pós-deploy, validar MP4 com `ffprobe` no runner e executar soak/observação.

Além disso, a configuração real de produção ainda precisa ser alinhada antes do go-live: LLM está desativada (`LLM_PROVIDER=none`), Turnstile está inconsistente entre UI/backend e e-mail verificado está desligado.

Nota de segurança: tokens e chaves operacionais passaram pelo fluxo de configuração desta sessão. Antes de declarar produção comercial, rotacionar credenciais de cloud, storage, deploy e LLM.
