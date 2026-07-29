# Validação E2E completa de produção — PicaShorts

Data: 2026-07-20  
Ambiente: produção (`https://picashorts.com`)  
API: `https://api.picashorts.com`  
Build validado: `549285c738c14d3255e8f7b9c63f39daa641f029`  
Conta QA: `qa-prod-20260720t1452z@clipbr.test`  
Artefatos brutos: `/tmp/picashorts-prod-e2e-20260720T1452Z`

## Resultado executivo

**Resultado global: PASS.**

Os seis arquivos testados produziram transcript, segmentos, scores, cortes, captions, conteúdo SEO, preview reproduzível e export MP4. Todos os 48 estágios observados — 36 automáticos e 12 de render/export — terminaram em `SUCCEEDED` na primeira tentativa.

O primeiro corte foi alterado no editor, persistiu após reload e gerou H.264/AAC 720×900. Os outros cinco downloads passaram em H.264/AAC 720×1280. Os casos reais de 2,77 s e 5,04 s também renderizaram; nenhuma mensagem de “vídeo curto demais” foi tratada como sucesso.

## Correções liberadas durante a rodada

O release validado reúne os seguintes commits:

- `7a86c8244c794bd75bd46f78e0240824c13a9160` — endurecimento do fluxo completo de mídia;
- `bd9869bc769809a27bd52d38e39f9aa72ed36e4a` — correções do release gate e upload de 5 GiB;
- `31692f3029d2a4969f46c0fcb0bbb5de6def5783` — isolamento dos consumidores BullMQ no worker dedicado;
- `549285c738c14d3255e8f7b9c63f39daa641f029` — correção do CORS do storage e timeout de upload sem progresso.

O workflow oficial `29750569349` aprovou lint, testes, coverage/builds, manifests, regressão de upload de 5 GiB, stack real PostgreSQL/Redis/MinIO/IA, E2E completo isolado, soak de 10 minutos, build e scan das quatro imagens e deploy na VPS: `https://github.com/arturconrado/supercortelikes/actions/runs/29750569349`.

### Defeito de produção encontrado e corrigido

Na primeira tentativa, o browser criou a sessão multipart, mas nenhum byte chegou ao MinIO. O preflight retornava `Access-Control-Allow-Origin` duas vezes: uma pelo Caddy e outra pelo CORS nativo do MinIO. O Chromium rejeitou a resposta.

A correção removeu a duplicação do Caddy e passou a usar a resposta dinâmica do MinIO. Também foi adicionado ao cliente um timeout total de 15 minutos e um timeout de 60 segundos sem progresso por parte, com retry e renovação da URL assinada. Depois do deploy:

```text
preflight OPTIONS: 204
Access-Control-Allow-Origin: https://picashorts.com
quantidade do header: 1
primeiro upload real confirmado pelo browser: ~6 s
```

## Método

- Cadastro, login, navegação, criação do projeto, uploads, previews, edição, renders e downloads foram executados por Chromium/Playwright contra a produção.
- Nenhum mock foi usado no teste de produção.
- API, banco, Redis, MinIO, Loki, Prometheus e Docker foram usados para observação, correlação e limpeza.
- Billing foi somente leitura. Cobrança, e-mail, publicação social, importação por URL e correções externas de DNS ficaram fora do teste funcional.
- Health, filas, DLQ, outbox, recursos e restarts foram coletados a cada 15 segundos.

## Conta, projeto e navegação

O cadastro pela interface manteve a sessão e redirecionou diretamente para `/dashboard`.

```text
user:      a5937b5d-0ccb-4cf6-9240-3e15857ab657
workspace: 1e4a8a68-5141-4862-affb-1d6bc6206040
project:   da50de32-d0c7-4871-9f0e-a9add826bc36
name:      QA Produção 20260720T1452Z
```

As oito rotas passaram: dashboard, biblioteca, projetos, exports, analytics, settings, billing e upload. O SSE `/videos/:id/events` respondeu HTTP 200 e a UI acompanhou o pipeline em tempo real.

## Entradas

| Arquivo | Bytes | SHA-256 | Duração |
|---|---:|---|---:|
| `O erro que destrói seus resultados em Wow.mp4` | 8.907.027 | `aaf50a7dc68504dde6a73f5f3279d9c660d28820d54ba4f58666c33b27e5f7b4` | 27,853 s |
| `A verdade sobre Pode usar o lado fin desse aldo se vocês não.mp4` | 17.582.043 | `7e8b7dd99061c07a5ea893da12db5e5abe2f2991f3daf3bdcb5538e1624c494b` | 49,950 s |
| `marmitas-de-macarrão-com-queijo-pra-semana-fácil.mp4` | 9.036.529 | `1358b2dd86960ac67b458d5d6c0de45e10836e4e2a1bcb3c13e0626f52b119cf` | 227,566 s |
| `revelado-garou-poder-máximo-que-mudança-brutal-one-punch-man-233.mp4` | 51.313.589 | `8d72f656bfe7e2ea38586c1d84febb667ffd384b8bb085c6d9d4d1f8112e2a9e` | 972,090 s |
| `qa-short-2.77s.mp4` | 2.234.655 | `a8f37c40a101efb7b26587795b8642568e3eb434b8046751e37b72fc6a9c6446` | 2,760 s |
| `qa-short-5.04s.mp4` | 4.139.685 | `6a2c68e01fbd5568209d1c9e9166083aa9e7afed52870dcebebd15ba510053a6` | 5,040 s |

## Resultado por vídeo

| Arquivo / vídeo | Dados persistidos | Transcrição | Render | Download | Resultado |
|---|---|---:|---:|---|---|
| `O erro...` / `0ee76611-...` | 1 transcript, 1 segmento/score, 1 corte/caption/SEO, 1 export | 21,625 s | 43,890 s | H.264/AAC 720×900, 27,528 s | PASS |
| `A verdade...` / `30546eaf-...` | 1 transcript, 2 segmentos/scores, 2 cortes/captions/SEO, 1 export | 41,020 s | 36,485 s | H.264/AAC 720×1280, 23,490 s | PASS |
| `marmitas...` / `8c444f31-...` | 1 transcript, 9 segmentos/scores, 5 cortes/captions/SEO, 1 export | 142,025 s | 18,199 s | H.264/AAC 720×1280, 27,853 s | PASS |
| `revelado-garou...` / `8a61309a-...` | 1 transcript, 43 segmentos/scores, 5 cortes/captions/SEO, 1 export | 537,306 s | 13,683 s | H.264/AAC 720×1280, 16,617 s | PASS |
| `qa-short-2.77s` / `460a4544-...` | 1 transcript, 1 segmento/score, 1 corte/caption/SEO, 1 export | 6,835 s | 2,190 s | H.264/AAC 720×1280, 2,000 s | PASS |
| `qa-short-5.04s` / `71ea6eb7-...` | 1 transcript, 1 segmento/score, 1 corte/caption/SEO, 1 export | 6,654 s | 3,440 s | H.264/AAC 720×1280, 4,120 s | PASS |

Cada linha teve `INGESTION`, `TRANSCRIPTION`, `SEGMENTATION`, `SCORING`, `CLIPS`, `CAPTIONS`, `RENDERING` e `EXPORTS` em `SUCCEEDED`, todos com `attempts=1`.

O arquivo de 972,090 s consumiu 537,306 s na transcrição em CPU: aproximadamente 0,55× o tempo do conteúdo, sem retry e sem esgotar memória.

## Editor, preview e persistência

Primeiro corte:

```text
clip:              855238e3-8a2b-4ca3-a152-aadc263a602c
timing original:   0,0–27,9 s
timing editado:    0,2–27,7 s
formato:           4:5
caption template:  marketing
cores:             #ff3366 / #33ff99
tamanho/posição:   44 / middle
título:            QA E2E 20260720T1452Z
export:            5a3f42d2-7d91-4916-b67e-fe94853d456c
```

Timing, formato, estilo e SEO permaneceram após reload. O player do editor carregou 24 cues WebVTT nativas, reproduziu e aceitou seek sem erro. O download validado por `ffprobe` contém H.264 720×900, AAC e duração 27,5275 s, SHA-256 `a5b20fe943675abe35f712567cf1f7159827a659bd7883acb79097fdb296fc05`.

Os seis sources e os seis renders foram carregados em elementos `<video>`, reproduzidos e submetidos a seek. Não houve `pageerror`, erro de console ou resposta HTTP >= 400 no resultado final.

Uma primeira sessão do harness ficou presa no `play()` de um source. Uma segunda sessão isolada carregou o mesmo objeto em 2,1 s; leituras públicas completa e Range responderam em 0,62 s e 0,05–0,24 s. A continuação em browser limpo passou o mesmo preview e os demais casos. O evento foi classificado como estado transitório da automação, não falha reproduzível do produto.

## Recursos e estabilidade

Picos medidos a cada 15 segundos durante upload/processamento/render:

| Recurso | Pico |
|---|---:|
| media-worker CPU | 362,51% |
| media-worker RAM | 21,80% da VPS |
| API CPU / RAM | 72,45% / 1,44% |
| worker CPU / RAM | 35,00% / 1,20% |
| web CPU / RAM | 39,67% / 1,06% |
| disco `/` | 57% |
| restarts | 0 |

O media-worker usou até aproximadamente 3,63 dos quatro vCPUs e permaneceu muito abaixo do limite de 85% de memória. Isso mantém a transcrição/render próximos do máximo útil da VPS sem ampliar infraestrutura.

Durante processamento/render houve amostras isoladas com `outbox.unpublished=1`; cada evento foi drenado até a coleta seguinte de 15 segundos. Não houve DLQ, job failed ou backlog residual. O Prometheus não tinha alerta em `firing` ao final da fase funcional. A consulta Loki correlacionada com cada um dos seis IDs encontrou zero eventos `error`/`fatal` da API, worker e media-worker.

### Soak após o último render

A janela começou após o último render, em `2026-07-20T15:13:43Z`. Foram analisadas 123 amostras entre `15:13:49Z` e `15:44:20Z`, totalizando 1.830,224 s (30 min 30 s), com intervalo máximo de 15,026 s e nenhuma lacuna superior a 30 s.

```text
readiness diferente de ok:        0
build divergente:                 0
pipeline diferente de ok:         0
DLQ/outbox/failed/waiting/active:  0
jobs delayed:                      0
restarts/containers não running:  0
alertas Prometheus firing:         0
erros de coleta:                   0
pico de memória da VPS:            34,94%
pico de disco:                     57%
```

O monitor continuou após a limpeza e confirmou novamente `ready=ok`, `pipeline=ok`, `dlq=0`, `outbox=0` e nenhuma fila ativa.

## Limpeza

A limpeza foi executada depois do soak:

- os seis `DELETE /videos/:id` responderam HTTP 204;
- `DELETE /account` respondeu HTTP 204 em `2026-07-20T15:44:54Z`;
- uma nova tentativa de login respondeu HTTP 401;
- a verificação no PostgreSQL retornou zero usuários, workspaces, projetos, vídeos, uploads, pipelines, transcripts, segmentos, cortes, captions, exports, usage events e outbox ligados aos identificadores QA;
- foram varridos 150 objetos e zero multipart uploads no MinIO, sem objeto residual associado aos seis vídeos;
- não restou diretório `/data/pipelines/<video-id>` no media-worker;
- o health final manteve readiness e pipeline `ok`, build exato, oito filas com um worker cada e zero waiting/active/delayed/failed, DLQ e outbox.

Todos os containers permaneceram `running`, com zero restart. Após a limpeza, o disco estava em 56% e a VPS usava aproximadamente 2,5 GiB de 7,8 GiB de RAM.

## Evidências

Artefatos fora do repositório:

```text
/tmp/picashorts-prod-e2e-20260720T1452Z/result.json
/tmp/picashorts-prod-e2e-20260720T1452Z/continuation-result.json
/tmp/picashorts-prod-e2e-20260720T1452Z/trace-final-sanitized.zip
/tmp/picashorts-prod-e2e-20260720T1452Z/screenshots/
/tmp/picashorts-prod-e2e-20260720T1452Z/downloads/
/tmp/picashorts-prod-e2e-20260720T1452Z/monitor.jsonl
```

Os JSONs e o trace foram sanitizados. A varredura final não encontrou senha QA, JWTs, Bearer headers, tokens ou parâmetros sensíveis `X-Amz-*` nos artefatos textuais e no trace descompactado.

## Complemento: matriz completa do editor

A validação posterior das 120 combinações discretas do editor, cinco casos contínuos e 125 downloads está documentada em [production-editor-matrix-validation-2026-07-20.md](./production-editor-matrix-validation-2026-07-20.md). O complemento registra as correções de SAR, fontes determinísticas e exclusão integral de dados da conta.
