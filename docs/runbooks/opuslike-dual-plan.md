# Produção Opus-like — CPU local e IA/GPU serverless

## Estado seguro

O runtime padrão continua no Plano A, sem custo novo:

```dotenv
COMPOSITION_V1_ENABLED=false
COMPOSITION_V1_ROLLOUT_PERCENT=100
MEDIA_ACCELERATOR=cpu
WHISPERX_MODEL=small
WHISPERX_DEVICE=cpu
WHISPERX_COMPUTE_TYPE=int8
MEDIA_HEAVY_CONCURRENT_JOBS=1
FFMPEG_CRF=19
RENDER_MAX_SOURCE_SHORT_SIDE=1080
AI_EXECUTION_MODE=local
STT_PROVIDER=whisperx
GPU_PROVIDER=none
AUTO_RENDER_MODE=off
FINAL_MAX_SHORT_SIDE=1080
```

`COMPOSITION_V1_ENABLED=false` mantém o render anterior enquanto o código novo é implantado. Em QA, altere somente a flag para `true`. Cortes antigos criam a composição no próximo preview/export; não existe backfill.

O estágio `COMPOSITION` escolhe `fill`, `split` ou o fallback seguro `fit`, persiste o plano por clipe e mantém captions depois do layout. Preview usa 540p; export final usa no máximo 1080p sem upscale, H.264/AAC, CRF 19, `faststart`, SAR 1:1 e loudness de -14 LUFS.

## Rollout do Plano A

1. Aplicar a migration e implantar com a flag desligada.
2. Em QA, definir `COMPOSITION_V1_ENABLED=true`, `COMPOSITION_V1_ROLLOUT_PERCENT=100` e manter `MEDIA_ACCELERATOR=cpu`.
3. Rodar a suíte de 12 vídeos e o E2E de upload → preview → export.
4. Em produção, manter a flag ligada e alterar `COMPOSITION_V1_ROLLOUT_PERCENT` para 10, 50 e 100 somente quando não houver restart, DLQ ou regressão dos limites do benchmark. O bucket por `videoId` é determinístico.
5. Para rollback, definir `COMPOSITION_V1_ENABLED=false`. O schema e as composições persistidas permanecem compatíveis.

A implementação atual usa detecção facial a 2 fps, fluxo óptico a 4 fps, análise de movimento da região de fala apenas com múltiplos rostos, janela de voz de 100 ms, confiança mínima 0,65 e estabilização de layout de 600 ms. Se o orçamento de análise for excedido ou o sujeito for perdido, o layout vira `fit`.

## Plano B aprovado: IA gerenciada sem segunda VPS

O modo híbrido mantém API, PostgreSQL, Redis, MinIO e filas na VPS atual. Deepgram recebe uma URL de leitura com validade máxima de uma hora; Runpod recebe a mesma fonte e URLs de escrita por objeto. Essas URLs não são salvas no banco, no resultado do estágio nem no estado de retomada do job.

Ative somente depois da aprovação do custo variável e de criar o endpoint Runpod:

```dotenv
COMPOSITION_V1_ENABLED=true
AI_EXECUTION_MODE=hybrid
STT_PROVIDER=deepgram
DEEPGRAM_API_KEY=...
DEEPGRAM_MODEL=nova-3
LLM_PROVIDER=openrouter
LLM_API_KEY=...
OPENROUTER_EDITOR_MODEL=google/gemini-2.5-flash
OPENROUTER_QA_ENABLED=true
GPU_PROVIDER=runpod
RUNPOD_API_KEY=...
RUNPOD_ENDPOINT_ID=...
AI_COST_LIMIT_USD_PER_SOURCE_HOUR=1.00
REMOTE_MAX_CONCURRENCY=2
AUTO_RENDER_MODE=all
FINAL_MAX_SHORT_SIDE=1080
```

Construa a imagem do endpoint serverless sem alterar a VPS:

```bash
docker build -f services/media-worker/Dockerfile.serverless \
  -t REGISTRY/media-worker-gpu-serverless:SHA services/media-worker
docker push REGISTRY/media-worker-gpu-serverless:SHA
```

No Runpod, configure uma fila assíncrona com A4000/A4500 e L4 como fallback, `workersMin=0`, `workersMax=2`, idle timeout de 5 segundos e a imagem acima. Os segredos do endpoint são `LLM_PROVIDER=openrouter`, `LLM_API_KEY`, `OPENROUTER_EDITOR_MODEL` e `OPENROUTER_QA_ENABLED=true`; não copie credenciais do PostgreSQL, Redis ou MinIO para o endpoint.

O fluxo híbrido faz o seguinte:

1. Deepgram Nova-3 retorna timestamps, palavras e speakers, normalizados no contrato do WhisperX.
2. Gemini combina 70% da avaliação editorial com 30% das regras locais para ranking, fronteiras, título, gancho e keyword.
3. No híbrido, `COMPOSITION` persiste um plano `fit` diferido sem analisar a fonte; o estágio seguinte envia um único job Runpod, que baixa a fonte uma vez, substitui o plano diferido, compõe e renderiza todos os cortes selecionados com NVENC.
4. Cada render gera uma contact sheet de seis frames. Gemini avalia enquadramento, rosto, legenda, barras e foco; uma reprovação permite exatamente um rerender `fit` conservador.
5. A API aceita o resultado somente depois de `HEAD` e conferência do tamanho. Deepgram, OpenRouter e Runpod geram `UsageEvent` idempotente.

O teto de US$1 por hora-fonte é rígido. Com menos de 50% do orçamento restante, QA visual é desativado; com menos de 25%, a análise cai de 10 para 6 fps; sem orçamento suficiente para o próximo provedor, o estágio usa CPU local. Timeout, 429, JSON inválido, URL expirada ou indisponibilidade também retornam ao caminho local.

## OpenRouter

OpenRouter é usado somente na curadoria textual/scoring. Ele não acelera WhisperX, OpenCV/YOLO, tracking ou FFmpeg. Para priorizar baixa latência:

```dotenv
LLM_PROVIDER=openrouter
OPENROUTER_EDITOR_MODEL=google/gemini-2.5-flash
LLM_PROVIDER_SORT=latency
```

O request exige suporte aos parâmetros utilizados e bloqueia provedores que permitam coleta de dados. Falha, timeout ou JSON inválido retornam ao scoring heurístico local; portanto OpenRouter não é dependência do pipeline e deve permanecer `LLM_PROVIDER=none` antes da aprovação.

## Benchmark de 12 vídeos

Preencha as fontes em `benchmarks/opuslike-suite.json`, processe exatamente os mesmos vídeos no PicaShorts e na conta QA do OpusClip e registre um JSON `benchmarks/opuslike-results.json` com `plans.cpu` e, após aprovação, `plans.hybrid`.

O documento raiz deve informar `costs.cpuMonthlyTotal` e `costs.limitUsdPerSourceHour`. Preencha `plans.cpu` e `plans.hybrid`; cada plano deve conter 12 objetos com estes campos (os dois últimos são obrigatórios no híbrido):

```json
{
  "id": "solo-01",
  "category": "solo",
  "sourceDurationSeconds": 600,
  "pipelineToCompositionSeconds": 420,
  "clipDurationSeconds": 45,
  "renderSeconds": 55,
  "soloSpokenFrames": 1000,
  "soloSafeFrames": 980,
  "speakerDecisions": 100,
  "correctSpeakerDecisions": 90,
  "maxOffSceneJumpWidthRatio": 0.05,
  "captionMeanErrorMs": 80,
  "preference": "PICASHORTS",
  "peakMemoryPercent": 62,
  "vpsCpuP95Percent": 34,
  "allFinalsAvailableSeconds": 210,
  "variableCostUsd": 0.12,
  "restarts": 0,
  "dlq": 0
}
```

Gere o relatório e faça o comando falhar se algum critério não for atendido:

```bash
npm run benchmark:opuslike -- benchmarks/opuslike-results.json reports/opuslike-benchmark.md
```

## Troca integral futura da VPS por GPU

Esta alternativa continua inativa e só deve ser reconsiderada acima de 500 horas/mês. Não crie uma segunda máquina. A GPU deve substituir a VPS atual e só pode ser proposta quando o custo total mensal aprovado incluir máquina, disco persistente, snapshots, tráfego e sobreposição de migração. O alvo mínimo é 4 vCPU, 8 GB RAM, 8 GB VRAM, NVIDIA CUDA/NVENC, IP público, Docker e armazenamento persistente equivalente. API, PostgreSQL e storage não podem depender de spot/preemptible.

Depois da aprovação financeira:

1. Gerar e verificar backup de PostgreSQL, storage e configurações.
2. Criar a máquina substituta e instalar NVIDIA Container Toolkit.
3. Validar o Compose sem iniciar serviços:

   ```bash
   docker compose -f docker-compose.vps.yml -f docker-compose.gpu.yml config --quiet
   ```

4. Subir a stack com o override GPU e executar `scripts/vps/validate-gpu.sh`, E2E e benchmark.
5. Restaurar dados, congelar uploads, sincronizar o delta e trocar DNS.
6. Manter o snapshot de rollback apenas na janela aprovada e remover a VPS anterior antes de ultrapassar o teto mensal.

O override GPU usa WhisperX `large-v3-turbo` float16, Pyannote, YOLO/ByteTrack a 5 fps com tracking a 10 fps, landmarks MediaPipe para movimento labial e NVENC CQ 19. Os contratos de composição, preview e export são os mesmos do Plano A.
