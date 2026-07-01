# OpenRouter E2E local — ClipBR AI

Data: 2026-07-01

Resultado: ✅ PASS

Ambiente:

- Compose: `docker-compose.one.yml`
- Projeto: `clipbr-one`
- Container: `clipbr-one-clipbr-1`
- Modo: all-in-one local production-like
- LLM provider: `openrouter`
- LLM model: `openai/gpt-4o-mini`

Fluxo validado:

1. Health inicial API/pipeline.
2. Geração de fixture MP4 com FFmpeg/flite.
3. Cadastro de usuário.
4. Login/autenticação por JWT.
5. Criação de projeto.
6. Upload multipart direto via URL assinada MinIO.
7. Confirmação de upload.
8. Pipeline completo:
   - ingestion;
   - transcription;
   - segmentation;
   - scoring com OpenRouter;
   - clips;
   - captions;
   - rendering;
   - exports.
9. Consulta de transcript, clip, SEO, caption e export.
10. Download assinado do MP4 final.
11. Validação do MP4 com `ffprobe`.
12. Health final com DLQ/outbox zerados.

Evidências:

- Video ID: `41c031d3-f279-4bdd-a0d5-7662dbfe73ed`
- Pipeline Run ID: `02b3d7c0-945e-43be-9571-d4104746db98`
- Clip ID: `64722ea7-a8cd-46f5-ab56-a845729394a9`
- Export ID: `a0f9817f-5252-4a87-99e7-36a90b3ac16c`
- Pipeline status: `SUCCEEDED`
- Dead letters abertas: `0`
- Outbox pendente: `0`
- Export download: HTTP `200`
- Export bytes: `4014639`
- `ffprobe`: `h264`, `1080x1920`
- Sinais persistidos no viral score com campos de LLM:
  - `hook`
  - `retention`
  - `clarity`

Observações:

- A chave real da OpenRouter não foi registrada neste relatório.
- O primeiro runner ad hoc falhou somente na consulta auxiliar ao banco por quoting de shell depois do pipeline já ter concluído. A consulta foi refeita com heredoc seguro e confirmou o resultado.
- O texto sintetizado pelo `flite` foi transcrito em inglês pelo WhisperX, mas o fluxo técnico completo funcionou e a LLM foi usada no scoring.

