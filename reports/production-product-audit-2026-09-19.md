# Auditoria completa do produto em produção — PicaShorts

Data: 2026-09-19  
Ambiente: `https://picashorts.com`  
Método: navegação automatizada visível no Chrome, conta nova de auditoria e mídia royalty-free.

## Escopo

- Superfície pública e documentos legais.
- Cadastro, autenticação e recuperação.
- Dashboard, biblioteca, projetos, exportações, analytics, billing e configurações.
- Upload/importação, processamento, editor, legendas, composição, render e download.
- Qualidade visual, UX, acessibilidade básica, mensagens de erro e console.
- Validação técnica do arquivo exportado.

## Registro de execução

| Área | Resultado atual | Evidência/observação |
| --- | --- | --- |
| Landing page | PASS inicial | CTAs, planos e explicação do fluxo carregaram em produção. |
| Cadastro | PASS com observação | Regras de senha e aceite legal funcionam; conta nova criada. |
| Autenticação | PASS com observação | A conta entrou automaticamente no dashboard após o cadastro. Não houve etapa visível de verificação de e-mail. |
| Recuperação de senha | PASS visual | Tela e CTA carregam; envio não executado para evitar fluxo paralelo antes do E2E principal. |
| Termos/Privacidade/Reembolso | PASS funcional / UX fraca | Conteúdo existe e versões são identificadas, mas cada documento aparece como bloco único, com baixa escaneabilidade. |
| Dashboard vazio | PASS | KPIs zerados, CTA de primeiro vídeo e estados vazios coerentes. |
| Biblioteca vazia | PASS | Busca, filtro de status, grade/lista e CTA disponíveis. |
| Projetos vazio | PASS | CTA e estado vazio coerentes. |
| Exportações vazio | PASS | Estado vazio e navegação corretos. |
| Analytics | PASS visual / dados inconsistentes | KPIs carregam, porém créditos aparecem como 0/0, divergindo do saldo de 60 min. |
| Plano e cobrança | PASS visual | FREE, Pro R$ 59 e Business R$ 149 exibidos; nenhuma compra foi iniciada. |
| Configurações | PASS visual | Perfil, brand kit, segurança e notificações carregaram. |
| Upload por arquivo | BLOQUEIO AMBIENTAL | O macOS negou Computer Use no seletor nativo; alternativa URL pública exercitada. |
| Importação por URL | PASS | Duas URLs MP4 foram aceitas e criaram itens na biblioteca. |
| Processamento — pet 1:15 | FALHA | WhisperX/FFmpeg não carregou áudio; pipeline entrou em retry. |
| Processamento — carro 0:27 | FALHA | WhisperX não encontrou fala; pipeline entrou em retry. |
| Editor/legendas/render/export | BLOQUEADO PELO PIPELINE | Nenhum corte foi produzido; não existe artefato legítimo para abrir no editor ou exportar. |

## Achados

### A-001 — Verificação de e-mail não apresentada após cadastro

- Severidade preliminar: média.
- Tela: cadastro → dashboard.
- Observado: após criar a conta, o usuário foi autenticado e enviado diretamente ao dashboard.
- Risco: se a política esperada for `EMAIL_VERIFICATION_REQUIRED=true`, o comportamento permite acesso antes da comprovação do endereço; caso seja intencional, a interface/documentação precisa deixar isso claro.
- Status: requer confirmação de configuração e teste de operações protegidas.

### A-002 — Documentos legais com baixa legibilidade

- Severidade preliminar: baixa.
- Telas: Termos, Privacidade e Reembolso.
- Observado: todo o conteúdo é apresentado em um único bloco de texto, sem seções, listas ou hierarquia intermediária.
- Impacto: dificulta leitura, entendimento e localização de direitos/obrigações.

### A-003 — Formulário de cadastro sofre rerenderizações agressivas

- Severidade preliminar: baixa/média.
- Observado na automação: alterações nos campos invalidam repetidamente a árvore de acessibilidade; o valor do e-mail também não é exposto no estado acessível.
- Impacto possível: automação assistiva e leitores de tela podem encontrar instabilidade. Requer auditoria manual de foco e anúncio de alterações.

### A-004 — Preço do Pro ausente na landing page

- Severidade preliminar: média.
- Observado: a landing mostra `BRL/mês`, sem o número; a tela de cobrança informa R$ 59/mês.

### A-005 — Contador de créditos inconsistente

- Severidade preliminar: média.
- Observado: Analytics mostra `Créditos usados 0 / 0`, enquanto dashboard e cobrança informam 60 minutos disponíveis no FREE.

### A-006 — Tamanho do arquivo importado aparece como 0 B

- Severidade preliminar: baixa/média.
- Observado: o MP4 de pet tem 29 MB e duração 1:15. A duração foi identificada corretamente, mas os detalhes mostram tamanho `0 B`.

### A-007 — Canal de progresso em tempo real indisponível

- Severidade preliminar: operacional.
- Observado: a interface acionou e comunicou corretamente o fallback de polling seguro a cada 3,5 s.

### A-008 — Bloqueio de download pelo navegador de teste

- Classificação: ambiente, não atribuído ao produto.
- Observado: o Vivaldi bloqueou o CDN do Pixabay com `ERR_BLOCKED_BY_CLIENT`. As páginas, licenças e URLs foram validadas visualmente e os mesmos arquivos foram obtidos via HTTP.

### A-009 — Pipeline não trata vídeo sem áudio antes da transcrição

- Severidade preliminar: alta.
- Tela: detalhe/processamento do vídeo.
- Observado: o vídeo de pet chegou à etapa de transcrição, que entrou em `RETRYING` (tentativa 2) com `WhisperX transcription failed: Failed to load audio` e diagnóstico do FFmpeg exposto no log da interface.
- Impacto: vídeos válidos sem faixa de áudio podem consumir tentativas e falhar sem uma orientação útil. Deve haver detecção prévia de stream de áudio e caminho explícito para conteúdo silencioso.

### A-010 — Minutos debitados antes de processamento útil

- Severidade preliminar: alta.
- Observado: após o primeiro vídeo de 1:15 entrar em retry de transcrição, o saldo caiu de 60 para 58,74 minutos, embora nenhum corte tenha sido produzido.
- Impacto: o usuário pode perder créditos em conteúdo que o pipeline não consegue processar. Confirmar política de estorno em falhas definitivas.

### A-011 — Segundo vídeo sem fala também fica em retry

- Severidade preliminar: alta (mesma causa-raiz de A-009).
- Observado: o vídeo de carro de 0:27 chegou a `WhisperX returned no speech segments`, alternando `RETRYING` e `PROCESSING` na tentativa 2, sem orientação específica ao usuário.

## Mídia de teste

- Carro: vídeo royalty-free do Pixabay, 27 segundos, carro grafitado; MP4 de 26 MB validado localmente.
- Pets: vídeo royalty-free do Pixabay, 1:15, gato descansando em banco; MP4 de 29 MB validado localmente.
- O seletor nativo de arquivo não pôde ser automatizado por falta da permissão de Computer Use no macOS. Foi usado o fluxo oficial `URL pública`.

## Próximas validações

- Corrigir ou definir o comportamento esperado para vídeos sem faixa de áudio/sem fala.
- Garantir estorno de minutos quando o pipeline falhar antes de produzir cortes.
- Repetir o E2E com mídia falada após a correção (ou declarar claramente esse requisito na seleção/importação).
- Validar editor, formatos, legendas, renderização, exportação e download, atualmente bloqueados pela falha anterior.
- Inspecionar o MP4 exportado e correlacionar com logs/filas quando houver render concluído.

## Implementação da correção multimodal — 2026-09-20

O código agora cobre os achados A-001 a A-011 nas áreas que podem ser validadas no repositório:

- ingestão persiste tamanho real, codecs, áudio, resolução, `processingMode`, fala detectada e contagem de falantes;
- mídia sem áudio ou sem fala segue para análise visual determinística, com cortes por cena/movimento/nitidez e sem legendas inventadas;
- Deepgram com diarização permanece como caminho principal configurável, com fallback local sem diarização quando o provedor falha;
- vídeos longos são segmentados em janelas limitadas e os stages continuam retomáveis por `pipelineRunId`;
- minutos passam por eventos idempotentes `reserved`, `committed` e `refunded`; falha terminal ou zero cortes estorna a reserva;
- Analytics usa o mesmo snapshot de uso do Billing e exibe usados, reservados e disponíveis;
- UI mostra modo de processamento, presença de áudio, fala e falantes; falhas permanentes deixam de parecer processamento infinito;
- preço Pro, documentos legais e orientação para mídia sem fala foram corrigidos;
- Grafana recebeu painéis de modos multimodais e ciclo de créditos; Prometheus recebeu gates de canário para 5xx >2%, sucesso <95%, jobs presos, ausência de fala e estornos;
- backup já existente foi documentado e ganhou procedimento de restore controlado em `docs/runbooks/backup-restore.md`.

### Validação automatizada do código

| Suíte | Resultado |
| --- | --- |
| API typecheck | PASS |
| API Vitest | PASS — 32 arquivos, 145 testes |
| Media-worker pytest | PASS — cenários de pipeline/recovery, incluindo vídeo-only |
| Web typecheck | PASS |
| JSON do dashboard Grafana | PASS |

Ainda é necessário executar o deploy/migration no VPS e repetir a matriz E2E com MP4s exportados. O endpoint público do Grafana depende de DNS `grafana.<APP_DOMAIN>` e das credenciais do ambiente; o `scripts/vps/deploy.sh` continua tratando DNS ausente como aviso, salvo quando `REQUIRE_GRAFANA_PUBLIC_ENDPOINT=true`.

### Checagem pública após a implementação

- `https://picashorts.com` respondeu HTTP 200 no Chrome.
- `https://api.picashorts.com` respondeu HTTP 404 na raiz, compatível com API sem rota pública nessa URL.
- `https://storage.picashorts.com/minio/health/live` respondeu HTTP 403, indicando endpoint protegido pelo gateway.
- `https://grafana.picashorts.com` não resolveu DNS durante a checagem; por isso não foi possível abrir o dashboard de produção no Chrome. O código do Caddy e o compose já possuem o host; falta publicar o registro DNS e executar o deploy.
- A landing pública ainda mostra `BRL/mês`, confirmando que as correções locais ainda não estão implantadas em produção.

## E2E real em produção — conta e upload direto — 2026-09-20

- Conta de auditoria criada no Chrome: `arturconrado+picashorts-e2e-20260920@gmail.com`.
- Login e dashboard: PASS.
- Importação por URL do YouTube: FALHA esperada do ambiente atual; a própria interface informou que o YouTube bloqueou a importação automática. O cenário foi encerrado sem insistir.
- Upload direto de `pet-cat-bench-75s.mp4` (29,4 MB): upload PASS, tamanho persistido corretamente; duração apareceu como `0:00` inicialmente e depois `1:15`.
- Pipeline do upload direto: FALHA/RETRYING em `TRANSCRIPTION`, com `WhisperX transcription failed: Failed to load audio`; nenhum corte foi produzido.
- A execução confirma que a versão implantada ainda não contém o fallback visual para mídia sem fala/sem áudio. Os cenários adicionais de upload foram pausados para evitar consumir créditos em uma versão conhecida como bloqueada.
