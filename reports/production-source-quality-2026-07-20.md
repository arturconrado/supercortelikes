# Validação da qualidade de origem em produção — 2026-07-20

## Escopo

- Export adaptativo de acordo com a classe de resolução da origem.
- Saídas sociais em H.264/AAC, pixels quadrados e proporção selecionada.
- Teto operacional de 4K (`RENDER_MAX_SOURCE_SHORT_SIDE=2160`) para proteger a VPS.
- Cache de render invalidado pela nova política de resolução.
- Planos e interface atualizados para “qualidade da origem até 4K”.
- Erros esperados por limite de plano deixam de abrir DLQ técnica.

## Alterações publicadas

- `9f0249834dc8d53e675d5b5387122ed7ecf43a5d` — resolução adaptativa até 4K.
- `4da08cbc13c6660e2a3a20eb600aeadcd8f4d616` — limite de plano classificado como falha acionável, sem DLQ.
- `5ebf5899990e3f47eab25616fd3daba4d1bd85b8` — lock de dependências corrigido após advisory novo do registry.

## Gates locais

- API/Web: 112 + 23 testes aprovados.
- Media worker: 57 testes aprovados.
- Typecheck: aprovado.
- ESLint: aprovado.
- Build de produção API/Web: aprovado.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilidades.
- Compose VPS validado com valores sintéticos para os segredos obrigatórios.
- Teste FFmpeg real:
  - origem 1280×720 → saída 720×1280, H.264/AAC, SAR 1:1;
  - origem 1920×1080 → saída 1080×1920, H.264/AAC, SAR 1:1;
  - origem 3840×2160 → saída 2160×3840, H.264/AAC, SAR 1:1.

## Gate operacional anterior ao teste

Foi identificado um upload real acima da duração do plano. O caso já era terminal, mas perdia o código e abria DLQ. O vídeo e a conta do cliente foram preservados; apenas o resíduo operacional conhecido foi descartado após correlação exata. Pipeline, outbox e todas as filas voltaram a zero antes de qualquer upload QA.

## Fixtures de produção

As fixtures curtas preservam o áudio/fala do vídeo QA de 5,04 s e exercitam a política por metadado de origem:

| Arquivo | SHA-256 | Origem esperada | Export 9:16 esperado |
| --- | --- | ---: | ---: |
| `source-1080p.mp4` | `ce73e04af1ab930c388bcd90f0ea756365e987eb9319ee5b69aa66d61bcd0905` | 1920×1080 | 1080×1920 |
| `source-4k.mp4` | `6997d8188a33c56e2c3171723694321daa16f731181c0dc89e2422a587b258d2` | 3840×2160 | 2160×3840 |

Artefatos brutos: `/tmp/picashorts-source-quality-prod-20260720T1832Z` (fora do repositório).

## Resultado em produção

**PASS** no commit `5ebf5899990e3f47eab25616fd3daba4d1bd85b8`.

- Workflow oficial: [VPS CI/CD #29781013329](https://github.com/arturconrado/supercortelikes/actions/runs/29781013329), concluído com sucesso.
- Conta QA criada pela interface; label de plano exibida: “Upload até 5 GB · qualidade da origem até 4K”.
- Os dois uploads foram feitos pela interface em seleção múltipla.
- Cada vídeo gerou transcript, segmentos, score, corte e caption; os seis estágios principais ficaram `SUCCEEDED` com uma tentativa.
- Preview da origem e do render reproduziram, fizeram seek e permaneceram sem erro de browser.
- Os dois downloads foram iniciados pelo navegador real.

| Caso | Preview origem | Pipeline observado | Render | Preview export | Playback / seek do export |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1080p | 1920×1080 | 8,27 s | 6,59 s | 1080×1920 | 406 ms / 101 ms |
| 4K | 3840×2160 | já concluído ao iniciar a espera do segundo vídeo | 22,16 s | 2160×3840 | 507 ms / 305 ms |

A rodada completa, incluindo navegador, previews, renders, downloads e limpeza, levou 79,30 s. O tempo de pipeline do segundo vídeo não representa a duração total do processamento, pois os dois foram enviados juntos e ele já estava concluído quando a validação sequencial chegou nele.

## `ffprobe` dos downloads

| Export | SHA-256 | Vídeo | Áudio | Resolução | SAR | Pixel format | Duração | Tamanho |
| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: |
| 1080p | `39b05dbdf64c058b026330fc7d4f42617c5d60f2b79f35bfba7c878070f7aae7` | H.264, 25 fps | AAC | 1080×1920 | 1:1 | yuv420p | 4,12 s | 1.056.479 bytes |
| 4K | `426748329e5b826a7f5bc6e167639002c6fb2a1b6911df1aca27f063dad9dc92` | H.264, 25 fps | AAC | 2160×3840 | 1:1 | yuv420p | 4,12 s | 9.232.450 bytes |

“Qualidade da origem” significa preservar a classe de resolução até o teto 4K. Reframe e legendas queimadas exigem recodificação; portanto, o arquivo não é bit a bit idêntico à origem. O encoder permanece em CRF 22 / preset `veryfast`, o equilíbrio adotado entre qualidade perceptual, tempo e custo da VPS.

## Recursos e estabilidade

- Monitor: 23 amostras, zero erros de coleta.
- Pico do media-worker: 334,86% CPU e 23,83% de RAM da VPS.
- Pico da API: 70,45% CPU e 1,10% de RAM.
- Disco: 67% durante toda a rodada.
- Restart: zero em todos os containers.
- Pós-teste: media-worker em 0,20% CPU e 9,04% RAM.
- Logs desde o início da rodada: API 178 linhas, media-worker 72 linhas, zero ocorrências `error/failed/exception/traceback`.

## Saúde e limpeza final

- Readiness: `ok`, SHA exato do release.
- Pipeline: `ok`.
- Todas as filas: waiting 0, active 0, delayed 0, failed 0.
- DLQ aberta: 0.
- Outbox pendente: 0.
- Conta, vídeos, pipelines e cortes QA no banco: 0.
- Objetos com os dois IDs QA no storage: 0.
- A conta QA e os dois vídeos foram excluídos ao final; senha e tokens não foram gravados no relatório.

IDs e tempos completos estão no `result.json`; amostras cruas estão em `vps-monitor.jsonl`, ambos no diretório de artefatos brutos fora do repositório.
