# Validação da matriz completa do editor em produção — PicaShorts

Data: 2026-07-20  
Ambiente: produção (`https://picashorts.com`)  
Build da matriz: `136407342decd130839bd6b06c6a9a50f03e12af`  
Build final, com limpeza corrigida: `e683187cba3a56ae7306bcb5d17957a46c7a5c26`  
Artefatos principais: `/tmp/picashorts-prod-editor-matrix-20260720T191006Z`

## Resultado executivo

**Resultado global: PASS.**

Foram exauridas as 120 combinações discretas disponíveis no editor:

```text
4 formatos × 5 templates × 3 posições × 2 estados de fundo = 120
```

Cada combinação foi salva pela interface, recarregada para provar persistência, reproduzida no preview, submetida a seek, renderizada, baixada e validada por `ffprobe`. As 120 passaram sem retry. Outros cinco renders cobriram extremos de tamanho e cores, totalizando 125 MP4 válidos.

Valores contínuos permitem infinitas combinações matemáticas — por exemplo, todos os timings e todas as cores RGB. Portanto, “todas” neste relatório significa todos os estados discretos do produto mais os limites e classes de equivalência relevantes dos campos contínuos.

## Matriz executada

| Dimensão | Valores | Casos |
|---|---|---:|
| Formato | `9:16`, `1:1`, `4:5`, `16:9` | 4 |
| Template | podcast, business, finance, marketing, motivational | 5 |
| Posição | top, middle, bottom | 3 |
| Fundo escuro | desligado, ligado | 2 |
| Fonte/cor adicionais | 18, 72, preto/branco, vermelho/verde, azul/magenta | 5 renders |

Resultado por formato:

| Formato | Combinações | Resolução | Codec | SAR | Resultado |
|---|---:|---:|---|---|---|
| 9:16 | 30/30 | 720×1280 | H.264/AAC | 1:1 | PASS |
| 1:1 | 30/30 | 720×720 | H.264/AAC | 1:1 | PASS |
| 4:5 | 30/30 | 720×900 | H.264/AAC | 1:1 | PASS |
| 16:9 | 30/30 | 1280×720 | H.264/AAC | 1:1 | PASS |

O lote independente posterior reabriu os 125 downloads com `ffprobe`: `FILES=125 FAILURES=0`. Todos tinham duração de 4,12 s e áudio AAC.

## Entrada e fluxo real

```text
arquivo:  qa-short-5.04s.mp4
bytes:    4.139.685
SHA-256:  6a2c68e01fbd5568209d1c9e9166083aa9e7afed52870dcebebd15ba510053a6
source:   H.264/AAC, 1280×720, 5,04 s
```

Uma conta descartável foi criada pela interface. O arquivo foi enviado pelo multipart real, processado pelo pipeline e abriu no editor com quatro blocos de legenda. O preview source carregou, reproduziu e aceitou seek em 2,52 s. O timing usado na matriz foi 0,2–4,3 s.

```text
user:   68fca5cb-8b5a-44b8-a1de-97119dc70a12
video:  a8f39aa8-fc62-41b5-8989-daa37d4a819e
clip:   bc55dd3f-58f0-4560-9a5e-1636b3508529
```

O navegador executou todas as ações do usuário. Não foram usados mocks nem chamadas diretas para simular edição, preview, render ou download.

## Persistência, preview e validação visual

Em cada caso, o harness confirmou após reload:

- formato, template, posição, fundo, tamanho e cores persistidos;
- frame da prévia com a proporção selecionada;
- `<video>` pronto, duração correta, reprodução real e seek;
- export novo disponível para download;
- MP4 com dimensões, codecs e SAR esperados.

A comparação de quadros extraídos produziu:

```text
combinações funcionais:        120/120
quadros únicos:                120/120
pares fundo off/on distintos:   60/60
grupos top/middle/bottom:        40/40
grupos de cinco templates:       24/24
casos contínuos distintos:        5/5
```

As cinco famílias também foram inspecionadas visualmente em amostras equivalentes. Podcast, business, finance, marketing e motivational apresentam tipografias perceptivelmente diferentes.

## Limites e entradas contínuas

Todos os critérios abaixo passaram:

- timing com início igual ao fim rejeitado no cliente;
- timing negativo rejeitado;
- timing além da duração rejeitado;
- duração mínima válida aceita e persistida;
- tamanhos de fonte 18 e 72 aceitos e visualmente diferentes;
- cores extremas/preto/branco e combinações RGB contrastantes aplicadas;
- máximos dos campos SEO aceitos;
- conteúdo SEO UTF-8 aceito e persistido.

As duas respostas HTTP 400 e os dois erros de console capturados ocorreram exclusivamente nos PATCH de timing inválido intencionais. Houve zero `pageerror` e zero falha HTTP inesperada.

## Desempenho

Tempos dos 120 renders da matriz:

| Métrica | Tempo |
|---|---:|
| mínimo | 4,661 s |
| mediana | 5,193 s |
| p95 | 5,252 s |
| máximo | 8,249 s |

O máximo foi o primeiro render frio depois do deploy. Os seguintes estabilizaram majoritariamente entre 4,7 e 5,3 s.

Picos da VPS durante a matriz, coletados a cada 15 segundos:

| Recurso | Pico |
|---|---:|
| media-worker CPU | 270,10% |
| media-worker RAM | 17,89% da VPS |
| API CPU / RAM | 41,75% / 1,59% |
| worker CPU / RAM | 35,76% / 1,10% |
| web CPU / RAM | 44,03% / 1,02% |
| memória total da VPS | 33,19% |
| disco `/` | 62% |
| restarts | 0 |

O processamento serial aproveitou até aproximadamente 2,7 vCPUs no media-worker sem pressionar memória ou disco e sem ampliar a infraestrutura.

## Health, filas, logs e soak

Durante os 125 renders houve 107 amostras. Readiness permaneceu `ok`, o build não divergiu, DLQ/failed/waiting/delayed/restarts ficaram em zero. Oito amostras capturaram `outbox.unpublished=1` durante a publicação normal do evento; todas zeraram no ciclo seguinte, sem backlog residual.

O Loki retornou 1.816 linhas correlacionadas com o vídeo/corte QA e zero linhas contendo `error`, `exception`, `failed`, `failure`, `panic` ou `fatal`. O Prometheus retornou zero alertas firing e zero targets com `up == 0`.

### Soak pós-render

```text
início:                            2026-07-20T19:40:04.520Z
fim:                               2026-07-20T20:10:34.806Z
amostras:                          123
duração:                           1.830,286 s
maior intervalo:                   15,009 s
readiness/build incorreto:         0
pipeline diferente de ok:          0
DLQ/outbox/waiting/active/failed:   0
restarts/container parado:         0
erros de coleta:                   0
pico de memória da VPS:            32,19%
pico de disco:                      62%
```

## Defeitos encontrados e corrigidos

### 1. Pixel aspect ratio não quadrado

O primeiro MP4 9:16 era codificado em 720×1280, mas carregava SAR `404:405`; o Chromium o apresentava como 720×1283. A renderização e o reframe agora aplicam `setsar=1`, a prévia do editor respeita dinamicamente o formato escolhido e o cache de render foi versionado.

Commit: `2e9b432e17985f4cf4ecb42ba6428d094761d383`  
Workflow: https://github.com/arturconrado/supercortelikes/actions/runs/29764160836

### 2. Templates usando a mesma fonte fallback

A primeira matriz passou funcionalmente em 120/120, mas produziu apenas 24 quadros únicos: as fontes Montserrat/Arial/Poppins/Anton não estavam disponíveis e o libass usava DejaVu para todos os templates. A imagem agora inclui Fontconfig e cinco famílias determinísticas; o Dockerfile falha no build se alguma não resolver. Um teste local com cores/tamanho/texto idênticos produziu cinco hashes distintos antes do deploy.

Commit: `136407342decd130839bd6b06c6a9a50f03e12af`  
Workflow: https://github.com/arturconrado/supercortelikes/actions/runs/29768656100

### 3. Exclusão de conta deixava registros de vídeo órfãos

O serviço removia corretamente objetos do storage e workspaces de mídia, mas excluía workspace/usuário sem apagar as linhas de vídeo. A verificação encontrou um vídeo, um corte, uma legenda, SEO e 125 exports órfãos. Eles foram removidos de forma guardada pelos IDs QA.

A transação agora executa `video.deleteMany` com os IDs previamente preparados antes de apagar workspace e usuário. O teste de regressão, lint e typecheck passaram.

Commit: `e683187cba3a56ae7306bcb5d17957a46c7a5c26`  
Workflow: https://github.com/arturconrado/supercortelikes/actions/runs/29773603963

Os seis jobs desse workflow terminaram em success: os quatro release gates, publicação das imagens e deploy VPS.

## Prova final da limpeza corrigida

No build final `e683187…`, uma segunda conta foi criada pela interface, enviou/processou o mesmo MP4 e carregou o preview. Em seguida:

```text
user:                       100ba5c4-df47-462a-93c6-c4b47376d447
video:                      2cb6f4fa-ae58-4d40-8329-83d35f9c4dcd
clip:                       921e330a-323f-4f93-aaeb-e5ba79919027
/auth/me antes:             HTTP 200
DELETE /account:            HTTP 204
/auth/me com token antigo:  HTTP 401
```

A consulta independente posterior retornou zero para usuário, workspace, membership, projeto, vídeo, pipeline runs, corte, caption, export, SEO e outbox. Os prefixos `videos/<id>/`, `imports/<id>/`, `thumbnails/videos/<id>/` e `exports/<id>/` retornaram zero objetos. Não foi necessária limpeza manual nessa prova final.

O health final reportou o SHA exato, readiness/pipeline `ok`, oito filas com um worker cada, zero waiting/active/delayed/failed, DLQ e outbox. API, web, worker e media-worker estavam `healthy` com `RestartCount=0`.

## Evidências

```text
/tmp/picashorts-prod-editor-matrix-20260720T164928Z/  # primeira matriz/diagnóstico de fontes
/tmp/picashorts-prod-editor-matrix-20260720T191006Z/  # matriz final, 125 downloads/frames e monitor
/tmp/picashorts-prod-editor-matrix-20260720T201726Z/  # prova final de exclusão
/tmp/picashorts-caption-font-verification/            # render local das cinco fontes
```

Os artefatos principais somam aproximadamente 131 MB e incluem `result.json`, 125 downloads, 125 quadros extraídos, screenshots e `monitor.jsonl`. A varredura textual não encontrou senha QA, JWT, Bearer headers ou parâmetros `X-Amz-*`.
