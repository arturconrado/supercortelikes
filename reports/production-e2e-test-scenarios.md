# PicaShorts — Matriz de cenários E2E em produção

**Versão:** 2026-09-20  
**Ambiente:** `https://picashorts.com`  
**Execução:** Chrome visível + telemetria de API, filas, storage, Grafana e inspeção técnica do MP4  
**Objetivo:** validar upload direto de mídias válidas, processamento multimodal, edição, render, exportação, créditos e saúde operacional.

## Regra de execução

Cada seção abaixo é um caso independente. O card/cenário deve ser executado do início ao fim e conter evidências próprias. Não reutilizar um resultado de outro cenário como aprovação.

Fluxo obrigatório:

1. Abrir o produto no Chrome e registrar `buildVersion`, workspace e horário.
2. Capturar snapshot de saúde antes do upload: CPU, memória, disco, workers, fila, Redis, Postgres, MinIO, 5xx e DLQ.
3. Fazer **upload direto de arquivo**, sem URL, salvo no cenário negativo explicitamente marcado.
4. Registrar `videoId`, `pipelineRunId`, tamanho real, duração, codecs, resolução, presença de áudio, modo e falantes.
5. Acompanhar cada estágio até `completed`, `failed_terminal` ou `refunded`.
6. Abrir o editor, validar corte, enquadramento, áudio e legendas quando aplicável.
7. Renderizar, baixar o MP4 e inspecionar o artefato com `ffprobe`.
8. Capturar snapshot de saúde depois do cenário e fechar a contabilidade de minutos.

## Critérios globais de aprovação

- O upload aceita o formato e a duração permitidos pelo plano, sem carregar todo o arquivo em memória.
- Metadados reais são persistidos: tamanho, duração, codecs, streams, canais, resolução, `audioPresent`, `speechDetected`, `processingMode` e `speakerCount`.
- `speech` usa transcrição com diarização quando habilitada; falha transitória do provedor usa fallback local.
- `audio_no_speech` e `video_only` são válidos em `mode: visual`; não geram legendas inventadas.
- O progresso é real e o erro terminal é amigável, sem expor comando completo de FFmpeg.
- Minutos seguem o ciclo idempotente `reserved → committed` ou `reserved → refunded`; reprocessamento não duplica cobrança.
- MP4 exportado abre em player comum, tem duração esperada, áudio sincronizado quando existente, nenhum quadro preto inesperado e enquadramento aceitável.
- Sem DLQ nova, job preso por mais de 10 minutos, 5xx acima de 2%, sucesso abaixo de 95%, memória acima de 85% ou disco acima de 80%.

## Fixtures de mídia

### Já disponíveis no repositório

| Fixture | Uso | Observação |
| --- | --- | --- |
| `reports/audit-media/pet-cat-bench-75s.mp4` | smoke de upload, vídeo com fala/áudio real | 29,4 MB, aproximadamente 1:15 |
| `reports/audit-media/funny-painted-car-27s.mp4` | smoke curto e inspeção de exportação | aproximadamente 27 s |
| `reports/audit-media/downloaded/the-hitch-hiker-public-domain.webm` | vídeo longo com áudio/fala para podcasts e limite de plano | 1,3 GB, aproximadamente 1h10, domínio público declarado |
| `reports/audit-media/downloaded/handshake-public-domain.webm` | vídeo curto silencioso para modo visual | 209 KB, 3 s, Public Domain Mark 1.0 |
| `reports/audit-media/downloaded/hi-de-ho-public-domain-music.webm` | filme musical para `audio_no_speech`/sinais visuais | 229 MB, aproximadamente 1h03, domínio público declarado |

Manifesto de origem, licença e checksum: [`reports/audit-media/downloaded/README.md`](./audit-media/downloaded/README.md).

### Fixtures necessárias para a matriz completa

Os arquivos devem ser gerados ou obtidos com licença compatível antes da sessão pesada. Cada fixture deve ter checksum SHA-256 registrado no relatório de execução.

- `podcast-1h-single-speaker.mp4`
- `podcast-45m-two-speakers.mp4`
- `podcast-30m-three-speakers-overlap.mp4`
- `music-video-12m.mp4`
- `silent-vertical-8m.mp4`
- `low-resolution-portrait-90s.mov`
- `near-plan-limit-59m.webm`
- `invalid-corrupt.mp4`
- `deepgram-fallback-15m.mp4`
- `zero-clips-2m.mp4`
- `idempotent-reprocess-10m.mp4`

Para cada arquivo registrar: origem/licença, tamanho, duração, vídeo, áudio, canais, resolução, orientação, fala esperada, quantidade de pessoas e checksum.

---

## CEN-001 — Podcast de 1 hora, um falante

**ID:** `podcast-1h-single-speaker`  
**Entrada:** MP4, 3.600 s, 16:9, H.264 + AAC, um falante  
**Modo esperado:** `speech`  
**Legendas:** sim  
**Saída esperada:** MP4 H.264, 1080p ou resolução de projeto equivalente.

### Objetivo

Validar vídeo longo com um único falante, segmentação retomável, transcrição completa e exportação sem perda de sincronização.

### Passos

1. Fazer upload e confirmar tamanho/duração reais.
2. Confirmar `audioPresent=true`, `speechDetected=true`, `speakerCount=1`.
3. Acompanhar ingestão, reserva de minutos, transcrição, seleção de cortes e render.
4. Confirmar que o processamento usa blocos retomáveis e não trava em uma única etapa.
5. Abrir um corte no editor, alterar legenda e reframe, salvar e renderizar.
6. Baixar o MP4 e inspecionar duração, frames, codec, áudio e sincronização.

### Resultado esperado

- Todas as partes processadas sem duplicação de palavras ou lacunas longas.
- Legendas dentro da área segura, sem sobreposição e com timestamps coerentes.
- Reserva confirmada somente após cortes utilizáveis.
- `processing.minutes.committed` idempotente.

### Evidências

`videoId`, `pipelineRunId`, duração por estágio, contagem de segmentos, confiança média, URL do export, `ffprobe`, screenshot do Chrome e snapshot Grafana.

---

## CEN-002 — Podcast de 45 minutos, dois falantes com diarização

**ID:** `podcast-45m-two-speakers`  
**Entrada:** MP4, 2.700 s, 16:9, fala alternada, dois falantes  
**Modo esperado:** `speech`  
**Legendas:** sim  
**Diarização:** obrigatória.

### Objetivo

Validar identificação consistente de duas pessoas e preservação dos rótulos durante edição e exportação.

### Passos

1. Fazer upload e confirmar `speakerCount=2`.
2. Verificar labels estáveis (`Speaker 1`, `Speaker 2` ou nomes configurados).
3. Conferir timestamps nas trocas de fala.
4. Editar um corte que atravesse a troca de falante.
5. Aplicar legendas, reframe e render.
6. Inspecionar o MP4 e comparar trechos de fala com o speaker correto.

### Resultado esperado

- Alternância sem troca de identidade visual.
- Nenhum trecho falado descartado apenas por mudança de speaker.
- Confiança e diarização visíveis nos metadados/logs, não necessariamente na tela final.

### Evidências

Tabela de segmentos por falante, screenshots do editor, export baixado e métricas de diarização.

---

## CEN-003 — Podcast de 30 minutos, três falantes e sobreposição

**ID:** `podcast-30m-overlap`  
**Entrada:** MP4, 1.800 s, três falantes, fala simultânea  
**Modo esperado:** `speech`  
**Diarização:** obrigatória  
**Regra crítica:** preservar timestamps sobrepostos sem reutilizar a mesma trilha visual para pessoas diferentes.

### Passos

1. Fazer upload e confirmar três falantes detectados.
2. Localizar ao menos três trechos de sobreposição.
3. Conferir que os intervalos podem se sobrepor no transcript sem serem serializados incorretamente.
4. Gerar cortes e verificar que a composição não duplica rosto/trilha.
5. Editar legendas e renderizar.
6. Inspecionar áudio, sincronização e troca de enquadramento.

### Resultado esperado

- Sobreposição preservada nos dados.
- Uma pessoa não recebe a legenda ou enquadramento da outra.
- Se a composição não comportar duas legendas simultâneas, a decisão deve ser explícita e registrada, nunca silenciosamente descartada.

### Evidências

Segmentos sobrepostos, speaker labels, screenshot do corte, MP4 e log correlacionado.

---

## CEN-004 — Vídeo musical sem fala

**ID:** `music-video-12m`  
**Entrada:** MP4, 720 s, música/ruído, sem fala útil, 16:9  
**Modo esperado:** `visual`  
**Legendas:** não.

### Objetivo

Garantir que música e ruído não sejam tratados como falha de transcrição e que os cortes sejam escolhidos por sinais visuais.

### Passos

1. Fazer upload e confirmar `audioPresent=true`, `speechDetected=false`.
2. Confirmar aviso “Análise visual” e ausência de promessa de legendas automáticas.
3. Verificar cortes por cena, movimento, nitidez, rostos e composição.
4. Abrir editor e confirmar que legendas são opcionais/desabilitadas.
5. Renderizar e baixar.

### Resultado esperado

- `TRANSCRIPT_EMPTY` é resultado válido, sem retry infinito.
- Cortes têm início/fim em pontos visualmente úteis.
- Áudio musical permanece sincronizado no export.

---

## CEN-005 — Vídeo vertical completamente sem áudio

**ID:** `silent-vertical-8m`  
**Entrada:** MP4, 480 s, 9:16, nenhum stream de áudio  
**Modo esperado:** `visual`  
**Legendas:** não.

### Passos

1. Fazer upload e confirmar `audioPresent=false` sem entrar em transcrição.
2. Confirmar `processingMode=visual` e indicação de que não haverá legendas.
3. Validar detecção de cenas, movimento e pessoas.
4. Aplicar reframe vertical e verificar que rostos não são cortados.
5. Renderizar MP4 sem faixa de áudio inválida.

### Resultado esperado

- Upload válido não é retentado por ausência de áudio.
- Export abre corretamente e permanece sem áudio.
- Se o modo visual estiver desativado por configuração, falhar com erro permanente claro e sem cobrança.

---

## CEN-006 — Vídeo vertical de baixa resolução com uma pessoa

**ID:** `low-resolution-portrait-90s`  
**Entrada:** MOV, 90 s, 9:16, resolução baixa, fala de um falante  
**Modo esperado:** `speech`.

### Passos

1. Fazer upload e validar codec, rotação e resolução real.
2. Confirmar alerta de qualidade sem bloquear mídia válida.
3. Transcrever, selecionar corte e aplicar reframe.
4. Verificar `safeSubjectRate` e ausência de corte de cabeça/rosto.
5. Renderizar no limite suportado pelo plano.

### Resultado esperado

- Rotação EXIF não gera vídeo deitado.
- O sujeito principal permanece enquadrado.
- O export não inventa upscale incompatível nem produz quadros pretos.

---

## CEN-007 — Arquivo próximo ao limite do plano

**ID:** `near-plan-limit-59m`  
**Entrada:** WEBM, 3.540 s, 16:9, um falante  
**Modo esperado:** `speech`  
**Gate:** deve aceitar se estiver dentro do limite comercial; rejeitar antes de processar se exceder.

### Passos

1. Conferir limite e saldo antes do upload.
2. Fazer upload e confirmar duração real.
3. Observar reserva de minutos e uso de memória durante processamento.
4. Concluir pelo menos um corte, editar e exportar.
5. Confirmar saldo usado, reservado e disponível.

### Resultado esperado

- Nenhuma cobrança duplicada.
- Não carregar o vídeo inteiro em memória.
- Excesso de plano gera `PLAN_LIMIT_EXCEEDED`, sem retry e sem cobrança.

---

## CEN-008 — Mídia corrompida / formato inválido

**ID:** `invalid-corrupt`  
**Entrada:** arquivo corrompido ou extensão incompatível  
**Resultado esperado:** `INVALID_MEDIA`.

### Passos

1. Fazer upload do arquivo inválido.
2. Confirmar falha na validação/ingestão, antes de transcrição.
3. Verificar mensagem amigável e identificador de suporte.
4. Conferir que não houve retry, reserva definitiva, DLQ indevida ou cobrança.

### Critérios

- Não exibir comando completo do FFmpeg.
- Log técnico mantém causa original e correlação.
- Reenviar o mesmo arquivo não cria cobrança.

---

## CEN-009 — Indisponibilidade do Deepgram com fallback local

**ID:** `deepgram-outage`  
**Entrada:** MP4, 900 s, dois falantes  
**Modo esperado:** `speech`  
**Falha injetada:** provedor indisponível/timeout  
**Fallback:** WhisperX/Pyannote local.

### Passos

1. Ativar a flag determinística do workspace para fallback/teste de provedor.
2. Fazer upload e confirmar tentativa no caminho Deepgram.
3. Simular timeout/erro transitório.
4. Confirmar fallback local, sem duplicar minutos ou segmentos.
5. Validar speaker labels, timestamps, edição e MP4.

### Resultado esperado

- Falha transitória retentável apenas no limite configurado.
- Fallback registrado na UI e nos logs.
- Se ambos falharem, falha terminal com estorno.

---

## CEN-010 — Zero cortes utilizáveis e estorno

**ID:** `terminal-zero-clips`  
**Entrada:** MP4, 120 s, sem fala e sem sinais visuais suficientes  
**Modo esperado:** `visual`  
**Resultado esperado:** `NO_USABLE_CLIPS`.

### Passos

1. Fazer upload e confirmar reserva após ingestão.
2. Processar até conclusão sem cortes utilizáveis.
3. Confirmar evento `processing.minutes.refunded` exatamente uma vez.
4. Verificar saldo antes/depois e status terminal.
5. Reprocessar e confirmar que o estorno não é duplicado.

### Critérios

- Não permanecer em retry.
- Não exibir export vazio como sucesso.
- UI explica que não foram encontrados cortes utilizáveis.

---

## CEN-011 — Reprocessamento idempotente

**ID:** `idempotent-reprocess`  
**Entrada:** MP4, 600 s, um falante  
**Regra:** mesmo `pipelineRunId`/chave idempotente não pode cobrar ou criar artefatos duplicados.

### Passos

1. Executar o upload até gerar cortes.
2. Solicitar reprocessamento do mesmo item.
3. Interromper/repetir uma chamada de estágio de forma controlada.
4. Comparar eventos, créditos, cortes e exports antes/depois.

### Resultado esperado

- Uma reserva, um commit e nenhum commit duplicado.
- Artefatos substituídos/versionados de forma explícita.
- UI mostra histórico sem esconder a primeira execução.

---

## CEN-012 — Upload com múltiplas pessoas e reframe

**ID:** `upload-carrossel-multiple-people`  
**Entrada:** MP4, várias pessoas, alternância de enquadramento, áudio opcional  
**Modo esperado:** `speech` se houver fala; `visual` caso contrário.

### Passos

1. Fazer upload e registrar número de pessoas visíveis.
2. Validar detecção de rostos/pessoas e escolha do sujeito principal.
3. Gerar cortes em que pessoas entram e saem do quadro.
4. Aplicar reframe vertical/horizontal e revisar manualmente cada corte.
5. Renderizar e inspecionar o MP4.

### Resultado esperado

- Nenhum rosto é cortado sem justificativa.
- A mesma trilha visual não é reutilizada indevidamente para pessoas diferentes.
- O modo é coerente com a presença de fala e aparece no detalhe do processamento.

---

## Cenários negativos fora do lote de upload

### URL inacessível — `inaccessible-url`

Este caso é mantido para regressão da API, mas fica fora da sessão principal porque o foco é upload direto. Deve retornar `SOURCE_UNAVAILABLE`, sem retry infinito e sem cobrança.

### URL de provedor bloqueado

Registrar como limitação de integração, não como falha dos cenários de upload. Não misturar o resultado com a qualidade do pipeline multimodal.

## Checklist de inspeção do MP4 exportado

Para cada export:

- `ffprobe` confirma duração dentro da tolerância de 0,5 s;
- codec de vídeo e áudio compatíveis com o contrato comercial;
- resolução e orientação corretas;
- áudio presente somente quando esperado;
- nenhum quadro preto ou congelamento inesperado;
- sincronização áudio/vídeo conferida em pelo menos três pontos;
- legendas legíveis, dentro da área segura e sem cortes de palavras;
- rostos/pessoas dentro do enquadramento;
- arquivo baixado abre em player independente;
- checksum e tamanho registrados;
- `videoId`, `pipelineRunId` e build vinculados ao artefato.

## Registro de execução

| ID | Data/hora | Build | Workspace | Resultado | `videoId` | `pipelineRunId` | Export | Créditos | Evidência |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CEN-001 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-002 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-003 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-004 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-005 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-006 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-007 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-008 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-009 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-010 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-011 |  |  |  | Não iniciado |  |  |  |  |  |
| CEN-012 |  |  |  | Não iniciado |  |  |  |  |  |

## Critério de liberação

Liberar primeiro para o workspace de auditoria. Avançar para 10%, 50% e 100% somente quando todos os cenários críticos concluírem até download, os eventos de minutos fecharem contabilmente e os gates de saúde permanecerem verdes. Reverter o canário em qualquer condição de stop definida nos critérios globais.

---

# Relatório de execução — sessão Chrome visível — 2026-09-20

**Ambiente:** `https://picashorts.com`  
**Conta de teste criada:** `arturconrado+picashorts-run-20260920@gmail.com`  
**Workspace exibido:** `PicaShorts E2E 2026-09-20`  
**Plano observado:** FREE — 60 min restantes  
**Browser:** Chrome visível, sessão `1888150816`  
**Resultado da sessão:** bloqueada no seletor nativo de arquivos do macOS antes do primeiro upload.

## Evidências coletadas antes do bloqueio

- Landing pública respondeu e exibiu os fluxos de cadastro, login, upload e exportação.
- Cadastro foi concluído no Chrome e redirecionou para `/dashboard`.
- Dashboard autenticado carregou com vídeos processados, cortes e downloads zerados.
- `/upload` carregou com seleção de arquivo, formatos MP4/MOV/WEBM/MKV/AVI, limite de 5 GB, configurações de duração, quantidade de cortes e formato.
- A conta mostrou `60 min restantes` antes de qualquer upload.
- Ao clicar em “Arraste seus vídeos aqui ou clique para escolher no computador”, a automação ficou bloqueada aguardando o seletor nativo; nenhum arquivo foi enviado e nenhum crédito foi consumido.

## Resultado por cenário

| ID | Cenário | Resultado | Ponto de parada | Observação |
| --- | --- | --- | --- | --- |
| CEN-001 | Podcast 1h, um falante | BLOQUEADO | Seleção de arquivo | Fixture disponível apenas no plano de preparação; não houve ingestão. |
| CEN-002 | Podcast 45m, dois falantes | BLOQUEADO | Seleção de arquivo | Diarização não exercitada. |
| CEN-003 | Podcast 30m, sobreposição | BLOQUEADO | Seleção de arquivo | Sobreposição não exercitada. |
| CEN-004 | Vídeo musical sem fala | BLOQUEADO | Seleção de arquivo | Modo visual não exercitado. |
| CEN-005 | Vídeo vertical sem áudio | BLOQUEADO | Seleção de arquivo | `video_only` não exercitado. |
| CEN-006 | Baixa resolução/retrato | BLOQUEADO | Seleção de arquivo | Reframe não exercitado. |
| CEN-007 | Próximo ao limite do plano | BLOQUEADO | Seleção de arquivo | Nenhuma reserva de minutos criada. |
| CEN-008 | Mídia corrompida | BLOQUEADO | Seleção de arquivo | Erro `INVALID_MEDIA` não exercitado nesta sessão. |
| CEN-009 | Falha Deepgram/fallback local | BLOQUEADO | Seleção de arquivo | Fallback não exercitado. |
| CEN-010 | Zero cortes/estorno | BLOQUEADO | Seleção de arquivo | Nenhum evento `refunded` criado. |
| CEN-011 | Reprocessamento idempotente | BLOQUEADO | Seleção de arquivo | Nenhum `pipelineRunId` criado. |
| CEN-012 | Múltiplas pessoas/reframe | BLOQUEADO | Seleção de arquivo | Detecção visual não exercitada. |

## Classificação do bloqueio

Este resultado é **bloqueio do ambiente de automação**, não aprovação nem reprovação do produto. O Chrome visível consegue acessar o produto, autenticar e abrir o upload, mas o seletor de arquivos nativo do macOS não está exposto à sessão automatizada. Como consequência, não há `videoId`, `pipelineRunId`, export, snapshot de fila ou evento de créditos para registrar.

## Retomada necessária

Para concluir a matriz em produção, é necessário executar novamente com uma destas condições:

1. permitir Computer Use para o seletor nativo do macOS;
2. usar um navegador/runner com suporte a `setInputFiles` mantendo a janela visível;
3. disponibilizar um fluxo oficial de upload por arquivo que aceite o fixture via controle web automatizável.

Não foram usados links públicos como substituto, porque esta sessão está restrita aos cenários de upload direto.

---

# Execução adicional com upload multipart oficial e Chrome visível — 2026-09-20

Esta retomada manteve a janela do Chrome aberta e usou somente o endpoint oficial de upload multipart para contornar o seletor nativo bloqueado. O navegador foi navegado para cada página de detalhe e os estados foram lidos visualmente por acessibilidade/polling.

| Caso | Fixture | Resultado observado | Evidência visível | Exportação | Créditos |
| --- | --- | --- | --- | --- | --- |
| S-NS-01 | `handshake-public-domain.webm` (3 s, WEBM, 208,6 KB) | **FAIL/REGRESSION** | Importação `SUCCEEDED`; transcrição `RETRYING` até a tentativa 3 com `WhisperX returned no speech segments`; 0 cortes; tela permaneceu `Processando` em 14% | Não chegou a render/export | Header permaneceu em 60 min |
| S-VO-01 | `pet-cat-bench-75s.mp4` (1:15, MP4, 29,4 MB, sem áudio) | **FAIL/REGRESSION** | Importação `SUCCEEDED`; transcrição `RETRYING` com `WhisperX transcription failed: Failed to load audio`; 0 cortes; tela permaneceu `Processando` em 14% | Não chegou a render/export | Header passou a 59 min após a ingestão |

## Identificadores

- S-NS-01: `projectId=789cfbed-d241-4665-afec-c86b08aeaecd`, `videoId=aa2081b8-3184-4106-832f-c7f0d96cec41`.
- S-VO-01: `projectId=0a3a428f-0e71-4b01-ad28-467e7b60713c`, `videoId=abc18a2b-0a06-4546-90bc-b4f66935a3b8`.
- `pipelineRunId` e export não foram expostos na tela nesta etapa; não foram inventados neste relatório.

## Falha do executor de testes corrigida durante a sessão

O helper [scripts/acceptance/upload-one-production.mjs](../scripts/acceptance/upload-one-production.mjs) enviava sempre `video/webm`. A API recusou o fixture MP4 com HTTP 415 antes da ingestão. O helper foi corrigido para inferir MIME por extensão (`mp4`, `mov`, `webm`, `mkv`, `avi`) e o upload MP4 seguinte foi aceito. Esse 415 é falha do harness, não do pipeline de produção.

## Conclusão da sessão

Os dois cenários executados até o fim observável falharam no caminho atual de transcrição para conteúdo sem fala/sem áudio. Isso confirma que o fallback visual e o tratamento não-retentável de `TRANSCRIPT_EMPTY`/ausência de áudio ainda não estão ativos no build observado em produção. Nenhum cenário foi aprovado até download de MP4; não houve base para validar editor, legendas opcionais, reframe, render ou integridade do export.
