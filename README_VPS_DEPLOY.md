# Deploy VPS all-in-one — ClipBR / Supercorteslikes

Este runbook sobe o produto completo em uma VPS única com Docker Compose, Caddy, PostgreSQL, Redis, MinIO, API, web, worker Node e media-worker Python/IA.

Status de entrada esperado: gate local aprovado em `reports/product-e2e-validation.md`.

## 1. VPS barata recomendada

- Provedor padrão atual: DigitalOcean.
- Alternativa barata recomendada: Hetzner Cloud.
- Região sugerida para Brasil: teste latência real. Em geral, `us-east`/Ashburn quando disponível tende a ser melhor que Europa para usuários no Brasil.
- Sistema: Ubuntu 24.04 LTS.
- Perfil econômico padrão: Basic Droplet 4 vCPU / 8 GB RAM / 160 GB SSD, com `VPS_SIZE_PROFILE=budget`.
- Primeiro upgrade recomendado se ficar lento: 8 vCPU / 16 GB RAM.
- Perfil confortável para jobs mais longos: 16 vCPU / 32 GB RAM.
- Disco: no perfil econômico, comece sem Volume extra e use o SSD do Droplet. Adicione um Volume Block Storage em `/srv/clipbr` quando o volume de uploads/exports crescer.
- Firewall público no provedor e no UFW: liberar somente `22/tcp`, `80/tcp`, `443/tcp`.

Esse desenho econômico é para lançamento rápido, demo comercial e primeiros clientes pequenos. Não é arquitetura enterprise/multi-região.

Referências operacionais: [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets), [DigitalOcean plans](https://docs.digitalocean.com/products/droplets/concepts/choosing-a-plan/), [DigitalOcean Cloud Firewalls](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/), [DigitalOcean Volumes](https://docs.digitalocean.com/products/volumes/) e [Hetzner Cloud](https://www.hetzner.com/cloud/).

Na página de preços consultada em 2026-06-28, o Basic Droplet 4 vCPU / 8 GB RAM / 160 GB SSD aparece por aproximadamente US$48/mês. Hetzner costuma ser mais barato para CPU/RAM equivalentes, mas confirme o preço final na tela do provedor antes de criar o servidor.

Perfis suportados pelo preflight:

| Perfil | Uso | Mínimo validado |
| --- | --- | --- |
| `budget` | MVP barato, jobs serializados, vídeos curtos/médios | 4 CPU, 7 GiB RAM, 120 GiB livres |
| `standard` | Primeiro upgrade saudável | 8 CPU, 15 GiB RAM, 250 GiB livres |
| `performance` | Mais folga para render/Whisper local | 16 CPU, 28 GiB RAM, 300 GiB livres |

O perfil `budget` mantém WhisperX `tiny`, CPU/int8, batch 1 e apenas 1 job pesado por vez. Se os jobs demorarem demais ou houver OOM, faça resize vertical do Droplet antes de mexer na aplicação.

## 1.1. Alternativa à DigitalOcean

Minha alternativa principal é **Hetzner Cloud**.

Use a mesma stack e os mesmos comandos. Só altere o provedor no `.env.production`:

```bash
VPS_PROVIDER=hetzner
VPS_SIZE_PROFILE=budget
```

Perfil Hetzner recomendado para começar:

- Ubuntu 24.04 LTS;
- x86;
- 4 vCPU;
- 8 GB RAM;
- pelo menos 120 GB livres em disco, idealmente 160 GB+;
- firewall liberando só `22`, `80`, `443`.

Se o plano Hetzner barato disponível tiver menos disco que isso, existem três caminhos:

1. adicionar volume;
2. reduzir temporariamente o gate de 5 GiB para smoke menor e manter 5 GiB só quando houver storage externo;
3. migrar mídia persistente para S3-compatible externo, como DigitalOcean Spaces, Cloudflare R2 ou outro bucket.

Plano B: **OVHcloud VPS** pode sair bem barato, mas muitos planos têm disco menor. Para este produto, disco pequeno é o limitador mais perigoso por causa de uploads, exports, cache de modelos e backups.

Plano C: **Vultr/Akamai Linode** são alternativas simples, mas normalmente não reduzem tanto o custo quanto Hetzner para CPU/RAM parecidos.

## 1.2. Decisão de arquitetura

Para este produto, o caminho rápido e controlável é:

```txt
Droplet
└── Docker Compose
    ├── caddy
    ├── web
    ├── api
    ├── worker
    ├── media-worker
    ├── postgres
    ├── redis
    └── minio
```

Não use App Platform, Agent ou Serverless Inference como primeira opção all-in-one. O produto precisa de arquivos grandes, diretórios temporários, fila, worker pesado, FFmpeg, IA e estado local controlado. Mesmo em uma única máquina, API e workers devem continuar separados em containers diferentes.

Se você for rodar modelos locais pesados com GPU, troque o alvo para **GPU Droplet** e prepare NVIDIA Container Toolkit/imagem compatível. O perfil atual usa WhisperX `tiny`, CPU/int8, batch 1 e concorrência pesada 1.

Storage:

- lançamento rápido: MinIO privado no Droplet via `storage.DOMINIO.com`;
- produção mais robusta: DigitalOcean Spaces S3-compatible para sources, captions e exports, mantendo `/srv/clipbr/data/media` só para artefatos temporários/cache.

O Compose atual usa MinIO local para reduzir dependências no primeiro go-live. Migração para Spaces é o próximo hardening recomendado antes de aumentar volume de clientes.

## 2. DNS

Substitua `DOMINIO.com` pelo domínio real:

```txt
DOMINIO.com          A      VPS_IP
api.DOMINIO.com      A      VPS_IP
storage.DOMINIO.com  A      VPS_IP
www.DOMINIO.com      CNAME  DOMINIO.com
```

Se usar Cloudflare, mantenha `storage.DOMINIO.com` em DNS-only. Proxy/CDN na frente do endpoint S3 costuma quebrar ou limitar uploads grandes.

## 3. Provisionamento inicial

Na VPS recém-criada, como `root`, confirme se você vai usar só o SSD do Droplet ou um Volume extra:

- perfil econômico: pode começar sem Volume extra;
- se usar Volume Block Storage, monte-o em `/srv/clipbr` antes do provisionamento.

Depois rode:

```bash
curl -fsSL https://SEU_REPO/raw/main/scripts/vps/provision-ubuntu.sh -o /tmp/provision-ubuntu.sh
bash /tmp/provision-ubuntu.sh
```

Ou, após clonar o repositório:

```bash
sudo scripts/vps/provision-ubuntu.sh
```

O script:

- instala Docker Engine e Compose plugin;
- cria usuário `clipbr`;
- cria swap de 8 GB;
- cria `/srv/clipbr/app`, `/srv/clipbr/data/*` e `/srv/clipbr/backups`;
- configura `ufw`, `fail2ban` e SSH sem senha.

Depois, entre como `clipbr`:

```bash
sudo -iu clipbr
cd /srv/clipbr/app
```

## 4. Configuração

Clone o repo em `/srv/clipbr/app` e crie o env:

```bash
cp .env.vps.example .env.production
chmod 600 .env.production
```

Edite `.env.production`:

- troque `DOMINIO.com` pelo domínio real;
- defina `VPS_PROVIDER=digitalocean`, `VPS_PROVIDER=hetzner` ou `VPS_PROVIDER=generic`;
- gere todos os secrets com `openssl rand -base64 48`;
- preencha Mercado Pago, Resend e Turnstile reais;
- deixe `TURNSTILE_BYPASS_TOKEN` vazio para produção pública. Se precisar usá-lo em uma janela privada de smoke, defina também `ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION=true` temporariamente e remova ambos antes do go-live;
- mantenha `POSTGRES_LOCAL_PORT=55432`, exposto apenas em `127.0.0.1`, para o smoke consultar o banco;
- confirme `S3_PUBLIC_ENDPOINT=https://storage.DOMINIO.com`;
- confirme `S3_CORS_ALLOWED_ORIGINS_JSON='["https://DOMINIO.com"]'`.

Webhook Mercado Pago:

```txt
https://api.DOMINIO.com/api/mercado-pago/webhook
```

## 5. Deploy

Antes do deploy, rode o preflight:

```bash
npm run vps:preflight
```

Ele valida `.env.production`, permissões do env, CPU/RAM/disco, metadata da DigitalOcean, DNS quando disponível e `docker compose config`.

Para o perfil barato, mantenha no `.env.production`:

```bash
VPS_SIZE_PROFILE=budget
```

```bash
npm run vps:deploy
```

Equivalente:

```bash
docker compose --env-file .env.production -f docker-compose.vps.yml -p clipbr-vps up --build --detach --wait
```

O Compose sobe:

- `caddy` nas portas `80/443`;
- `web`;
- `api`;
- `worker`;
- `media-worker`;
- `postgres`;
- `redis`;
- `minio`;
- `minio-init`;
- `migrate`.

PostgreSQL, Redis e MinIO não expõem portas públicas. O MinIO console fica desligado; se precisar inspecionar storage, use `docker compose exec minio`/`mc` ou SSH tunnel temporário.

Para migrar de MinIO local para DigitalOcean Spaces depois do primeiro lançamento:

1. crie um Space privado;
2. configure CORS para o domínio web, métodos `PUT`, `GET`, `HEAD`, `POST` e exposição de `ETag`;
3. configure lifecycle/retention;
4. troque `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` e `S3_FORCE_PATH_STYLE=false`;
5. remova a dependência de `minio`/`minio-init` em um Compose específico para Spaces;
6. rode `npm run vps:smoke` e `RUN_5G=true npm run vps:smoke`.

## 6. Smoke e gate na VPS

Smoke rápido:

```bash
npm run vps:smoke
```

O E2E completo consulta o banco para confirmar estados finais. O Postgres é publicado apenas em `127.0.0.1:55432` na VPS, então continua fechado para a internet.

Como produção exige e-mail verificado, antes do `npm run vps:smoke` crie/verifique uma conta de smoke e exporte:

```bash
export PRODUCT_E2E_EMAIL=smoke@DOMINIO.com
export PRODUCT_E2E_PASSWORD='SenhaForte123!'
```

Se você configurar `TURNSTILE_BYPASS_TOKEN` para gates internos em uma janela privada, o smoke usa esse token automaticamente como `PRODUCT_E2E_TURNSTILE_TOKEN`. Para o teste comercial final e para o go-live, deixe o bypass vazio e rode também o fluxo manual/externo com Turnstile real e e-mail entregue via Resend.

Gate com regressão 5 GiB:

```bash
RUN_5G=true npm run vps:smoke
```

O gate de 5 GiB reutiliza `PRODUCT_E2E_EMAIL`/`PRODUCT_E2E_PASSWORD`, ou `ACCEPTANCE_ACCESS_TOKEN` se você preferir passar um JWT manualmente. Em produção, não rode esse gate com usuário novo não verificado.

Checks manuais:

```bash
curl -fsS https://api.DOMINIO.com/health/ready
curl -fsS https://api.DOMINIO.com/health/pipeline
curl -fsS https://storage.DOMINIO.com/minio/health/live
```

Critérios mínimos:

- API ready `ok`;
- pipeline `ok`;
- `deadLettersOpen=0`;
- `outbox.unpublished=0`;
- product E2E `PASS`;
- export final baixa e passa em `ffprobe`;
- 10 minutos sem restart;
- 5 GiB multipart passa antes de abrir para clientes pagantes.

## 7. Backup

Backup manual:

```bash
npm run vps:backup
```

O script cria:

- `postgres.sql.gz`;
- mirror do bucket MinIO;
- hash do `.env.production`;
- cópia criptografada do env se `VPS_BACKUP_GPG_RECIPIENT` estiver configurado.

Cron diário sugerido como usuário `clipbr`:

```cron
15 3 * * * cd /srv/clipbr/app && /usr/bin/npm run vps:backup >> /srv/clipbr/backups/backup.log 2>&1
```

Recomendação: sincronize `/srv/clipbr/backups` para DigitalOcean Spaces, outro S3 externo, ou outro destino fora do Droplet. Backup no mesmo Droplet/Volume não conta como recuperação de desastre.

Antes de declarar produção comercial, execute um restore drill em uma VPS separada.

## 8. Rollback

Rollback para um SHA/tag:

```bash
npm run vps:rollback -- <SHA_OU_TAG>
```

Por padrão, o rollback faz backup antes de trocar o código. Para pular backup:

```bash
SKIP_BACKUP=true npm run vps:rollback -- <SHA_OU_TAG>
```

Não faça rollback destrutivo de banco. Use apenas código compatível com o schema atual ou restaure backup em ambiente separado.

## 9. Operação diária

Status:

```bash
docker compose --env-file .env.production -f docker-compose.vps.yml -p clipbr-vps ps
```

Logs:

```bash
docker compose --env-file .env.production -f docker-compose.vps.yml -p clipbr-vps logs -f --tail=200 api worker media-worker
```

Reiniciar serviço:

```bash
docker compose --env-file .env.production -f docker-compose.vps.yml -p clipbr-vps up -d --wait api worker
```

Inspecionar filas:

```bash
curl -fsS https://api.DOMINIO.com/health/pipeline | jq
```

## 10. Go-live comercial

Só declarar lançamento comercial quando:

- DNS e TLS finais estiverem verdes;
- `/metrics` continuar bloqueado publicamente e acessível somente por túnel/rede interna se necessário;
- Mercado Pago real estiver validado com webhook assinado;
- Resend estiver entregando e-mail;
- Turnstile estiver bloqueando abuso;
- backup diário estiver ativo;
- restore drill tiver passado;
- product E2E e 5 GiB tiverem passado na VPS;
- soak de 24h tiver passado;
- DLQ aberta = 0;
- outbox pendente = 0.
