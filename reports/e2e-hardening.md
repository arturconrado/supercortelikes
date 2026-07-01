# ClipBR AI — E2E browser hardening

Data: 2026-07-01

## Resultado

A suíte Playwright foi expandida de smoke mínimo para uma bateria browser E2E com 8 cenários isolados.

## Cobertura adicionada

- Cadastro:
  - indicador de qualidade de senha;
  - aceite legal;
  - contrato `displayName`, `acceptedTermsVersion` e `acceptedPrivacyVersion`.
- Importação por URL:
  - envio de `processingOptions`;
  - redirecionamento para `/library/:videoId`;
  - tela de processamento;
  - lista de cortes;
  - modal de preview;
  - abertura do editor.
- Upload direto multipart:
  - seleção real de arquivo no browser;
  - chamada a `presigned-upload`;
  - assinatura de partes;
  - PUT de parte simulando storage com `ETag`;
  - confirmação do upload;
  - redirecionamento para vídeo.
- Erros:
  - importação por URL inválida mostra erro e permanece em `/upload`;
  - timing inválido no editor bloqueia chamada de API.
- Pipeline:
  - vídeo com DLQ/erro mostra mensagem;
  - retry chama `/videos/:id/retry`;
  - erro some após retry.
- Editor:
  - salva timing;
  - salva formato;
  - salva estilo de legenda;
  - salva SEO;
  - solicita export.
- Biblioteca:
  - renderiza thumbnail real assinada;
  - abre vídeo importado.

## Arquivos adicionados/alterados

- `apps/web/e2e/fixtures.ts`
- `apps/web/e2e/product-smoke.spec.ts`
- `apps/web/e2e/upload-direct.spec.ts`
- `apps/web/e2e/video-pipeline.spec.ts`
- `apps/web/e2e/clip-editor.spec.ts`
- `apps/web/playwright.config.ts`

## Decisões de robustez

- Mocks isolados por teste.
- Seletores user-facing (`getByRole`, `getByLabel`, `getByText`).
- Sem `waitForTimeout`.
- `trace`, `screenshot` e `video` retidos em falha.
- Execução com `workers: 1` para evitar flake do Next dev/Turbopack durante compilação incremental.
- CORS e preflight simulados nos mocks.
- Storage multipart simulado com header `ETag` exposto.

## Validação executada

```bash
npm run test:e2e:web
npm run typecheck --workspace @clipbr/web
npm run lint
```

Resultado:

```text
8 passed
```

## Pendência fora desta suíte

Esta bateria valida o produto no browser com backend mockado. O fluxo real com PostgreSQL, Redis, MinIO, API, worker Node e media-worker AI continua coberto pelo gate:

```bash
npm run gate:local-full-ai
```

Esse gate deve ser executado em máquina com memória suficiente antes de declarar prontidão de release.
