# Validação E2E completa de produção — PicaShorts

Data: 2026-07-16
Ambiente validado: produção (`https://picashorts.com`)
API: `https://api.picashorts.com`
Build: `2bb65d759c9a6487e45b4ba5d6511b44edf1b5fc`
Conta QA: `qa-prod-20260716t1812z@clipbr.test` (excluída ao final)
Artefatos brutos sanitizados: `/tmp/picashorts-prod-e2e-20260716T1812Z`

## Resultado executivo

**Resultado global: FAIL.**

Os quatro arquivos produziram corte, preview renderizado e MP4 reproduzível. Os quatro downloads passaram no `ffprobe`; o primeiro saiu em H.264/AAC 720×900 após edição para 4:5 e os demais em H.264/AAC 720×1280.

O resultado global é `FAIL` pelos critérios estritos da rodada:

1. `revelado-garou...mp4` precisou de 3 tentativas em `TRANSCRIPTION` e 2 em `RENDERING`.
2. O cadastro retornou sucesso, mas a interface foi redirecionada para `/login` em vez de manter a sessão. O comportamento foi reproduzido em mais de uma conta QA.
3. A sessão expirou durante o processamento longo; a reautenticação recebeu `429 Rate limit exceeded` e interrompeu o fluxo original do navegador.
4. O SSE `/videos/:id/events` foi bloqueado por CORS para os quatro vídeos. A interface concluiu por polling, mas o canal SSE não passou.
5. O player tentou carregar o track SRT assinado de outro domínio e o Chromium registrou bloqueio de mesma origem.
6. O alerta Prometheus `PicashortsLongRunningRender` permaneceu em `firing` mesmo após todos os exports ficarem `READY`, a fila zerar e a conta QA ser removida.
7. A exclusão via API deixou thumbnails, diretórios temporários do media-worker e eventos outbox publicados; todos os resíduos QA foram removidos manualmente por IDs exatos.
8. Os dois arquivos descritos no plano como 2,77 s e 5,04 s têm, na produção, 227,566 s e 972,090 s. Assim, o caso de borda de vídeos realmente curtos não foi exercitado por esses arquivos.

## Escopo e método

- Todas as ações reais de usuário foram executadas em produção por Chromium/Playwright contra `picashorts.com`.
- Cadastro, login, criação do projeto, uploads, edição, renders e downloads foram acionados pela interface.
- A API e o banco foram usados apenas para observação, correlação e limpeza.
- Não foram usados mocks no teste de produção.
- Billing foi somente leitura. Cobrança, e-mail, publicação social, importação por URL e deploy ficaram fora do escopo.
- Não houve alteração de API, schema ou código do produto.

## Baseline local do harness

O Chromium do Playwright foi instalado e o baseline mockado foi executado antes da produção:

```text
npm run test:e2e:web
8 passed
```

Dois seletores ambíguos do harness foram tornados exatos em:

- `apps/web/e2e/product-smoke.spec.ts`
- `apps/web/e2e/video-pipeline.spec.ts`

Esse baseline foi apenas um preflight local e não participa do veredito de produção.

## Navegação e conta QA

As oito rotas verificadas passaram: dashboard, biblioteca, projetos, exports, analytics, settings, billing e upload.

Projeto criado pela interface:

```text
workspace: bdb998b9-06b7-43c4-ba84-b42e352642a0
project:   340cb58e-b1a9-4fb1-b408-fa5e3e7ad882
name:      QA Produção 20260716T1812Z
```

Falhas de autenticação observadas:

- O `POST /auth/register` concluiu, mas a interface foi para `/login` em vez de `/dashboard`.
- A sessão autenticada expirou enquanto o quarto vídeo era processado.
- A primeira reautenticação do fluxo longo recebeu HTTP 429 com mensagem de retry em 5 segundos.
- Uma continuação autenticada também voltou à tela de login uma vez antes de abrir o editor.

## Arquivos de entrada

| Arquivo | Bytes | SHA-256 | Duração observada em produção |
|---|---:|---|---:|
| `O erro que destrói seus resultados em Wow.mp4` | 8.907.027 | `aaf50a7dc68504dde6a73f5f3279d9c660d28820d54ba4f58666c33b27e5f7b4` | 27,853 s |
| `A verdade sobre Pode usar o lado fin desse aldo se vocês não.mp4` | 17.582.043 | `7e8b7dd99061c07a5ea893da12db5e5abe2f2991f3daf3bdcb5538e1624c494b` | 49,950 s |
| `marmitas-de-macarrão-com-queijo-pra-semana-fácil.mp4` | 9.036.529 | `1358b2dd86960ac67b458d5d6c0de45e10836e4e2a1bcb3c13e0626f52b119cf` | 227,566 s |
| `revelado-garou-poder-máximo-que-mudança-brutal-one-punch-man-233.mp4` | 51.313.589 | `8d72f656bfe7e2ea38586c1d84febb667ffd384b8bb085c6d9d4d1f8112e2a9e` | 972,090 s |

A duração dos dois últimos arquivos foi confirmada tanto pelo elemento `<video>` quanto pelo `durationMs` persistido no banco. Portanto, não são vídeos de 2,77 s e 5,04 s.

## Resultado por vídeo

| Vídeo / ID | Dados gerados | Pipeline | Preview e MP4 | Resultado |
|---|---|---|---|---|
| `O erro...` / `21332154-f13f-44ea-a63b-0b8c42de4644` | 1 transcript, 1 segmento, 1 score, 1 corte, 1 caption, 1 export | 8 estágios `SUCCEEDED`, tentativa 1 | Preview reproduzido; editado 4:5; H.264/AAC 720×900, 27,821 s | PASS |
| `A verdade...` / `1845d28c-90d0-40e6-8ef8-3414a1df17ba` | 1 transcript, 2 segmentos, 2 scores, 2 cortes, 2 captions, 1 export | 8 estágios `SUCCEEDED`, tentativa 1 | Preview reproduzido; H.264/AAC 720×1280, 23,490 s | PASS |
| `marmitas...` / `442fba1f-6eae-48d3-a46e-6ed8957bfac6` | 1 transcript, 9 segmentos, 9 scores, 5 cortes, 5 captions, 1 export | 8 estágios `SUCCEEDED`, tentativa 1 | Preview reproduzido; H.264/AAC 720×1280, 27,853 s | PASS, mas não é vídeo curto |
| `revelado-garou...` / `2164627f-720b-451d-b4ea-5a28fd872db7` | 1 transcript, 43 segmentos, 43 scores, 5 cortes, 5 captions, 1 export | Todos `SUCCEEDED`; transcrição tentativa 3 e render tentativa 2 | Source e render reproduzidos; H.264/AAC 720×1280, 16,617 s | FAIL pelo retry |

O produto executa seis estágios automáticos (`INGESTION` a `CAPTIONS`) e cria `RENDERING`/`EXPORTS` sob demanda quando o usuário solicita o MP4. Os oito foram exigidos e observados para cada vídeo.

### Tempos principais

| Vídeo | Transcrição | Tentativas | Render | Tentativas |
|---|---:|---:|---:|---:|
| `O erro...` | 19,550 s | 1 | 50,809 s | 1 |
| `A verdade...` | 47,627 s | 1 | 258,594 s | 1 |
| `marmitas...` | 214,702 s | 1 | 209,937 s | 1 |
| `revelado-garou...` | 785,623 s | **3** | 486,761 s | **2** |

Todos os demais estágios ficaram em `SUCCEEDED` com uma tentativa.

## Editor e persistência

No primeiro corte:

```text
clip: 876b9098-c291-4c6f-9359-904605f0e535
timing original: 0,0–27,9 s
timing editado:  0,2–27,7 s
formato:         4:5
caption template: marketing
cores:           #ff3366 / #33ff99
tamanho:         44
posição:          middle
título:           QA E2E 20260716T1812Z
```

Timing, formato, estilo e conteúdo SEO permaneceram após reload. O novo export usou fingerprint/ID próprio e passou no `ffprobe`:

```text
video: h264 720x900
audio: aac
duration: 27.820998
sha256: 84cc84cc9178753d42250769b6d9e775eae8d0e011b940dea91ae034611d3dc7
```

## Problemas de browser/UI

### SSE bloqueado por CORS

O console registrou repetidamente para os quatro vídeos:

```text
Access to fetch at https://api.picashorts.com/videos/<id>/events
has been blocked by CORS policy: No Access-Control-Allow-Origin header
```

O processamento apareceu na interface por polling, mas o SSE solicitado no plano não passou.

### Track de legenda cross-origin

O Chromium bloqueou a tentativa do `<track>` de carregar o SRT assinado em `storage.picashorts.com` a partir de `picashorts.com`. As URLs assinadas foram redigidas dos artefatos. A legenda visual do editor apareceu pelo overlay da UI, mas o track nativo do player precisa revisão de CORS/origem.

## Monitoramento da VPS

Período principal contínuo: 20:19:14–21:20:19 UTC, sem gaps acima de 30 segundos.

Picos medidos a cada 15 segundos:

| Recurso | Pico |
|---|---:|
| media-worker CPU | 344,70% |
| media-worker RAM | 28,64% |
| API CPU / RAM | 67,32% / 1,56% |
| worker CPU / RAM | 42,70% / 1,18% |
| Postgres CPU / RAM | 11,60% / 0,92% |
| RAM do host usada | 48,35% |
| Disco `/` | 51% |
| Restarts | 0 |

Durante a rodada houve uma amostra transitória às 20:36:00 UTC com `pipeline=degraded` e `outbox.unpublished=1`. Na amostra seguinte, às 20:36:15, voltou a `ok`/zero.

### Soak após o último render

O último `RENDERING` terminou às `20:49:44.986Z`. A janela final observada foi até `21:20:19.122Z`:

```text
123 amostras
1.834,136 segundos
readiness não-ok:       0
pipeline não-ok:        0
DLQ máximo:             0
outbox pendente máximo: 0
jobs failed máximo:     0
jobs ativos máximo:     0
gaps > 30 s:            0
```

O Loki retornou zero entradas de nível `error` correlacionadas aos quatro IDs no período da rodada.

### Alerta Prometheus residual

O snapshot final manteve um alerta em `firing`:

```text
alert: PicashortsLongRunningRender
expr:  clipbr_export_jobs{status="PROCESSING"} > 0
for:   1800 s
value: 1
activeAt: 2026-07-16T18:38:48.459863988Z
```

Após a limpeza, o banco tinha somente 18 exports globais `READY`, enquanto a métrica ainda expunha `PROCESSING=1` e `QUEUED=1`. Isso indica métrica cumulativa/estagnada sendo usada como gauge na regra, ou falta de decremento/remoção da série.

## Limpeza

Exclusão via API:

```text
DELETE vídeo 21332154-... -> 204
DELETE vídeo 1845d28c-... -> 204
DELETE vídeo 442fba1f-... -> 204
DELETE vídeo 2164627f-... -> 204
DELETE conta QA            -> 204
login após exclusão        -> 401
```

Resíduos encontrados depois da API:

- 17 thumbnails sob os quatro prefixos QA no MinIO.
- 4 diretórios de pipeline no media-worker, com aproximadamente 88 MB no total.
- 32 eventos outbox já publicados com os aggregate IDs QA; nenhum estava pendente.

Os resíduos foram removidos apenas pelos IDs QA conhecidos. Verificação final:

```text
users=0
workspaces=0
projects=0
videos=0
clips=0
pipelines=0
transcripts=0
segments=0
captions=0
exports=0
outbox QA=0
objetos QA MinIO=0
diretórios QA /data/pipelines=0
```

Health final:

```text
/health/ready    status=ok build=2bb65d7...
/health/pipeline status=ok
DLQ=0
outbox unpublished=0
queues waiting/active/delayed/failed=0
restarts=0
```

O alerta Prometheus residual continuou em `firing` após a limpeza.

## Evidências sanitizadas

Artefatos fora do repositório:

```text
/tmp/picashorts-prod-e2e-20260716T1812Z/result.json
/tmp/picashorts-prod-e2e-20260716T1812Z/result-attempt-1.json
/tmp/picashorts-prod-e2e-20260716T1812Z/verify-last-export.json
/tmp/picashorts-prod-e2e-20260716T1812Z/monitor.jsonl
/tmp/picashorts-prod-e2e-20260716T1812Z/trace-final-sanitized.zip
/tmp/picashorts-prod-e2e-20260716T1812Z/screenshots/
/tmp/picashorts-prod-e2e-20260716T1812Z/downloads/
/tmp/picashorts-prod-e2e-20260716T1812Z/video/
```

O trace e os JSONs foram sanitizados. JWTs, senha QA, headers Bearer e parâmetros sensíveis `X-Amz-*` não foram mantidos.

## Recomendação de correção

Ordem sugerida:

1. Corrigir persistência/refresh da sessão no cadastro e durante pipelines longos; separar o rate limit de login do fluxo legítimo de refresh/reautenticação.
2. Investigar timeout/concorrência de transcrição e render que levou o último arquivo a 3/2 tentativas.
3. Corrigir CORS do endpoint SSE e do track SRT no storage.
4. Transformar `clipbr_export_jobs` em gauge de estado atual ou alterar a regra Prometheus para consultar backlog/idade reais.
5. Incluir thumbnails, workspaces temporários e outbox publicado no lifecycle de exclusão do vídeo/conta.
6. Repetir a rodada com arquivos comprovadamente de 2,77 s e 5,04 s para cobrir o caso de vídeo curto.
