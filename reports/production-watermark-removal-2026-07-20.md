# Remoção da marca d’água PicaShorts — validação em produção

Data: 2026-07-20  
Ambiente: `https://picashorts.com`  
Commit: `7cad1a4b89a4a572cb1c525d921d63ba03c1031a`  
Workflow: https://github.com/arturconrado/supercortelikes/actions/runs/29776902041  
Artefatos brutos: `/tmp/picashorts-watermark-free-20260720T2107541Z`

## Resultado

**PASS.** Um usuário do plano Free agora gera e baixa o corte sem a marca obrigatória “PicaShorts”. As legendas continuam presentes e o arquivo preserva os codecs, a resolução e o pixel aspect ratio esperados.

## Alteração liberada

- todos os planos passaram a declarar `limits.watermark=false`;
- foi removido o fallback automático para o texto `PicaShorts` e para o nome do brand kit;
- logo ou texto de marca do próprio cliente continuam opcionais e só entram no render quando configurados explicitamente;
- o fingerprint/cache de render foi versionado como `clip-render-720p-v5-no-platform-watermark`, impedindo o reaproveitamento de um MP4 antigo com a marca;
- landing page, upload, planos e configurações passaram a informar corretamente que os exports saem sem marca da plataforma;
- o plano público Free está em `2026-07-watermark-free-v2` e expõe `watermark=false`.

Foram adicionadas regressões para provar que um workspace sem marca explícita envia opções vazias ao media-worker e que uma marca própria explícita continua funcionando.

## Gates

- API: 110 testes aprovados;
- web: 23 testes aprovados;
- lint, typecheck e builds API/web aprovados;
- workflow oficial: seis jobs concluídos com `success`, incluindo stack real, E2E isolado, soak de 10 minutos, build/scan das quatro imagens, publicação, deploy e smoke da VPS.

Produção respondeu no SHA exato e API, web, worker e media-worker estavam `healthy`, todos com `RestartCount=0`.

## Teste real em conta Free

Entrada:

```text
arquivo:   qa-short-5.04s.mp4
bytes:     4.139.685
SHA-256:   6a2c68e01fbd5568209d1c9e9166083aa9e7afed52870dcebebd15ba510053a6
source:    H.264/AAC, 1280×720, 5,04 s
```

Identificadores QA:

```text
user:    283512ac-98f6-4044-a73b-d88665dff917
video:   d7453840-c295-48ad-8c1c-3cba307af06c
clip:    f3ef1aaa-89e8-40ad-a883-4d27a73e1324
export:  fc83d70c-938e-4e67-bb7d-1fc029884b23
```

O Chromium executou cadastro, upload multipart, acompanhamento do pipeline, abertura do corte, reprodução do preview com seek, solicitação de render e download. Não houve mock nem chamada direta para simular essas ações.

```text
upload:          3,899 s
pipeline:       15,366 s
preview:         readyState 4, 1280×720, duração 5,04 s, seek/reprodução OK
render/export:   8,374 s
pageerror:       0
falha HTTP funcional inesperada: 0
```

A indicação de quota no upload não continha mais “com marca d’água”. A landing e `/billing/plans` também confirmaram “Sem marca d’água” e `watermark=false` para o Free.

## Prova do MP4

```text
SHA-256:  ab22e6862d7d0e912f4d22189cdd1e06246304b0c6c41f328e18e182690aa498
vídeo:    H.264, 720×1280, SAR 1:1, DAR 9:16
áudio:    AAC
duração:  4,120 s
bytes:    657.766
```

Foram extraídos quatro quadros a 1 fps e montados em `watermark-free-contact-sheet.png`. Todos mantêm as legendas e nenhum contém o retângulo/texto “PicaShorts” que aparecia no canto inferior direito do build anterior. O quadro integral em 2 s está em `watermark-free-frame.png`.

## Saúde e recursos

Foram coletadas 17 amostras entre `21:05:04Z` e `21:10:28Z`, incluindo upload, transcrição, render e limpeza:

```text
readiness/build incorreto:    0
pipeline diferente de ok:    0
outbox máximo:                0
DLQ máximo:                   0
jobs failed/waiting:          0
jobs ativos máximo:           1
restarts:                     0
disco máximo:                 65%
```

Picos dos containers críticos:

| Container | CPU | RAM da VPS |
|---|---:|---:|
| API | 33,68% | 1,15% |
| Web | 0,05% | 0,55% |
| Worker | 19,46% | 0,84% |
| Media-worker | 226,09% | 13,08% |

O Loki retornou 26 linhas correlacionadas aos IDs QA, sem `error`, `exception`, `failed`, `panic` ou `fatal`. O Prometheus retornou zero alertas firing e sete de sete targets `up`.

## Limpeza

O primeiro `DELETE /videos/:id` da automação respondeu 400 porque o harness enviou `Content-Type: application/json` sem corpo, gerando uma requisição de limpeza malformada; isso ocorreu depois de o download já ter sido validado. O `DELETE /account` correto respondeu 204 e a sessão antiga passou a responder 401.

A verificação independente após a exclusão retornou:

```text
users:             0
videos:            0
clips:             0
exports:           0
pipeline_runs:     0
objetos com video: 0
```

O health final permaneceu `ok`, com outbox, DLQ e todas as filas zeradas.

## Evidências principais

```text
/tmp/picashorts-watermark-free-20260720T2107541Z/result.json
/tmp/picashorts-watermark-free-20260720T2107541Z/ffprobe.json
/tmp/picashorts-watermark-free-20260720T2107541Z/watermark-free-frame.png
/tmp/picashorts-watermark-free-20260720T2107541Z/watermark-free-contact-sheet.png
/tmp/picashorts-watermark-free-20260720T2107541Z/downloads/watermark-free-export.mp4
/tmp/picashorts-watermark-production-monitor.jsonl
```

Nenhuma senha, JWT, Bearer token ou URL assinada foi registrada no relatório.
