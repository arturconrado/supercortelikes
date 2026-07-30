# Produção Opus-like — CPU local e IA/GPU serverless

## Estado seguro

O runtime padrão continua no Plano A, sem custo novo:

```dotenv
COMPOSITION_V1_ENABLED=true
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

`COMPOSITION_V1_ENABLED=true` ativa o composition-v2 validado. Para rollback operacional, altere somente a flag para `false`. Cortes antigos criam a composição no próximo preview/export; não existe backfill.

O estágio `COMPOSITION` gera `composition-v2`, escolhe `fill`, `split` ou o fallback seguro `fit`, persiste o plano por clipe e mantém captions depois do layout. Preview usa 540p; export final usa no máximo 1080p sem upscale, H.264/AAC, CRF 19, `faststart`, SAR 1:1, PTS reiniciado, `aresample=async=1:first_pts=0` e loudness de -14 LUFS.

O enquadramento usa o perfil `social-center-v1`, ancorado no comportamento visual do OpusClip: o centro do rosto fica em 50% da largura e aproximadamente 38% da altura, preservando headroom e espaço inferior para captions. O centro facial precisa permanecer entre 20–80% da largura e 12–62% da altura; o rosto inteiro deve ficar dentro das margens seguras. Se o limite físico da fonte impedir esse enquadramento, `fill` é recusado: dois participantes usam `split` e um participante usa `fit`, em vez de entregar um rosto cortado ou descentralizado. A referência segue os princípios publicados pelo OpusClip para active speaker, centralização, movimento suave e layouts `fill`/`split`/`fit`; não replica componentes proprietários.

## Rollout do Plano A

1. Aplicar a migration e implantar com a flag desligada.
2. Em QA, definir `COMPOSITION_V1_ENABLED=true`, `COMPOSITION_V1_ROLLOUT_PERCENT=100` e manter `MEDIA_ACCELERATOR=cpu`.
3. Rodar a suíte de 12 vídeos e o E2E de upload → preview → export.
4. Em produção, manter a flag ligada e alterar `COMPOSITION_V1_ROLLOUT_PERCENT` para 10, 50 e 100 somente quando não houver restart, DLQ ou regressão dos limites do benchmark. O bucket por `videoId` é determinístico.
5. Para rollback, definir `COMPOSITION_V1_ENABLED=false`. O schema e as composições persistidas permanecem compatíveis.

A implementação atual usa os timestamps reais dos frames, inclusive em fontes VFR, detecção facial, fluxo óptico, IDs de track estáveis e análise de movimento da região de fala apenas com múltiplos rostos. A atividade de voz usa timestamps por palavra com tolerância de 40 ms; a troca de orador exige 250 ms contínuos e usa `split` durante a transição ambígua. Confiança mínima é 0,65 e a estabilização de layout é 600 ms. Se o orçamento de análise for excedido ou o sujeito for perdido, o layout vira `fit`.

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
OPENROUTER_VIDEO_ENABLED=true
OPENROUTER_VIDEO_MODEL=google/gemini-3-flash-preview
OPENROUTER_VIDEO_MAX_BYTES=20971520
OPENROUTER_VIDEO_TIMEOUT_SECONDS=90
OPENROUTER_VIDEO_RETRIES=3
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

No Runpod, configure uma fila assíncrona com A4000/A4500 e L4 como fallback, `workersMin=0`, `workersMax=2`, idle timeout de 5 segundos e a imagem acima. Os segredos do endpoint são `LLM_PROVIDER=openrouter` e `LLM_API_KEY`; configure também `OPENROUTER_EDITOR_MODEL`, `OPENROUTER_VIDEO_MODEL` e os respectivos flags de QA. Não copie credenciais do PostgreSQL, Redis ou MinIO para o endpoint.

O fluxo híbrido faz o seguinte:

1. Deepgram Nova-3 retorna timestamps, palavras e speakers, normalizados no contrato do WhisperX.
2. Gemini combina 70% da avaliação editorial com 30% das regras locais para ranking, fronteiras, título, gancho e keyword.
3. No híbrido, `COMPOSITION` persiste um plano `fit` diferido sem analisar a fonte; o estágio seguinte envia um único job Runpod, que baixa a fonte uma vez, substitui o plano diferido, compõe e renderiza todos os cortes selecionados com NVENC.
4. Cada render gera um proxy MP4 com áudio (480p/12 fps; fallback 360p/8 fps). Gemini avalia a sequência inteira, falante ativo, latência de troca, enquadramento, rosto, legenda, barras e sincronia A/V. Uma reprovação permite exatamente um rerender guiado pelas correções do modelo; falante ambíguo usa `split` e o fallback final usa `fit`.
5. A API aceita o resultado somente depois de `HEAD` e conferência do tamanho. Deepgram, OpenRouter e Runpod geram `UsageEvent` idempotente.

O teto de US$1 por hora-fonte é rígido. Com menos de 25% do orçamento restante, a análise cai de 10 para 6 fps. Sem orçamento para o OpenRouter, o render é preservado com qualidade `UNVERIFIED`; nunca é marcado silenciosamente como aprovado. Falha confirmada após o segundo render vira `REVIEW_REQUIRED` e o download final permanece oculto.

## OpenRouter

OpenRouter é usado na curadoria textual/scoring e como editor/revisor temporal do vídeo. Ele não substitui WhisperX, OpenCV/YOLO, tracking ou FFmpeg: o modelo decide e revisa; o FFmpeg executa a edição determinística. Para priorizar baixa latência:

```dotenv
LLM_PROVIDER=openrouter
OPENROUTER_EDITOR_MODEL=google/gemini-2.5-flash
OPENROUTER_VIDEO_MODEL=google/gemini-3-flash-preview
LLM_PROVIDER_SORT=latency
```

O request exige suporte aos parâmetros utilizados, ativa ZDR e bloqueia provedores que permitam coleta de dados. O vídeo é enviado em base64 somente no proxy temporário de até 20 MiB. Falha, timeout ou JSON inválido preservam o render como `UNVERIFIED`; portanto OpenRouter não é uma dependência destrutiva do pipeline.

A API de geração de vídeo do OpenRouter não é usada para estes cortes: ela recria conteúdo, não preserva deterministicamente o vídeo original e não é elegível a ZDR. A integração utiliza entrada multimodal de vídeo para planejar/revisar a edição e mantém o FFmpeg como renderizador.

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
  "spokenSubjectFrames": 1000,
  "safeSubjectFrames": 980,
  "speakerDecisions": 100,
  "correctSpeakerDecisions": 90,
  "speakerSwitchLatenciesMs": [180, 240, 310],
  "maxOffSceneJumpWidthRatio": 0.05,
  "captionMeanErrorMs": 80,
  "avStartDeltaMs": 12,
  "avDurationDeltaMs": 35,
  "qualityFalsePasses": 0,
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
