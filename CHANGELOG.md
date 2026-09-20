# Changelog

Todas as alterações relevantes do produto são registradas neste arquivo.

## [0.2.0] - 2026-09-20

### Adicionado

- Pipeline multimodal para vídeos com fala, áudio sem fala e vídeo sem áudio.
- Matriz de cenários E2E para uploads diretos em produção.
- Observabilidade de filas, modos de processamento, estornos e exportações.
- Runbook de backup e restauração de Postgres e MinIO.
- Registro de versão semântico para o monorepo e seus aplicativos.

### Corrigido

- Reserva, confirmação e estorno idempotentes de minutos de processamento.
- Tratamento de transcrição vazia e fallback para análise visual.
- Metadados de mídia e progresso real expostos na interface.
- Alertas e painéis de saúde do worker e da infraestrutura.

### Validação

- Testes unitários de API e worker aprovados no commit `500d3d8`.
- Deploy de produção acompanhado pelo workflow VPS CI/CD.
- Cenários de URL permanecem fora da rodada atual; a validação em produção usa somente upload direto.

## Convenção de releases

- `MAJOR`: mudanças incompatíveis de contrato ou migrações obrigatórias.
- `MINOR`: novas funcionalidades compatíveis.
- `PATCH`: correções compatíveis.

Cada release deve atualizar as versões do root, API, web e `package-lock.json`, adicionar uma entrada neste arquivo e incluir o SHA do commit implantado. Tags devem seguir `vMAJOR.MINOR.PATCH`.
