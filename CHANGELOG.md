# Changelog

Todas as alterações relevantes do produto são registradas neste arquivo.

## [0.2.6] - 2026-09-20

### Corrigido

- Inicialização Redis/BullMQ idempotente para impedir que a API caia com `Redis is already connecting/connected` durante reinícios do deploy.

## [0.2.5] - 2026-09-20

### Segurança e release

- Atualizado o Next.js para 16.3.5 e o `sharp` para a versão segura transitiva.
- Mantida a versão de Fastify compatível com o Nest/multipart atual; as vulnerabilidades restantes são moderadas e não bloqueiam o gate configurado.

## [0.2.4] - 2026-09-20

### Corrigido

- Bloqueio de vídeos-fonte com menos de 60 segundos antes do upload quando a duração é legível no navegador.
- Validação server-side por `ffprobe` com erro terminal `SOURCE_TOO_SHORT`, sem retries ou reserva de minutos.
- Métricas de espera na fila e duração total do pipeline para medir a otimização de performance.
- Painel Grafana com p95 de fila e pipeline total.

## [0.2.3] - 2026-09-20

### Corrigido

- Fixture do teste de transcrição híbrida atualizado para persistir metadados de mídia antes da etapa de transcrição.

## [0.2.2] - 2026-09-20

### CI/CD

- Gate rápido para pushes e gate completo sob execução manual de release.
- Validação pesada preservada para uma única rodada antes da promoção final.

## [0.2.1] - 2026-09-20

### Corrigido

- Compatibilidade de tipo da configuração Playwright visível (`slowMo` em `launchOptions`).
- Gate de qualidade para permitir a promoção do deploy de produção.

### Operação do CI

- Pushes usam o gate rápido; a integração longa, o upload de 5 GiB e o soak de 10 minutos ficam reservados para uma execução manual de release.
- A validação completa deve ser executada uma vez antes da promoção final da versão.

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
