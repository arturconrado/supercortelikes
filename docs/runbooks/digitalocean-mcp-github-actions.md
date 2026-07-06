# DigitalOcean MCP + GitHub Actions — VPS ClipBR

Este runbook conecta duas peças:

1. **MCP da DigitalOcean** para criar/inspecionar recursos da conta.
2. **GitHub Actions** para buildar imagens, publicar no GHCR e fazer deploy por SSH na VPS.

O MCP não deve ser tratado como runtime obrigatório do deploy. Ele é uma interface operacional para o agente criar, consultar e revisar infraestrutura. O deploy reprodutível continua sendo feito por GitHub Actions.

## 1. Segurança antes de começar

Nunca cole tokens DigitalOcean em chat, código, commits ou logs.

Se um token foi exposto:

1. revogue o token na DigitalOcean;
2. gere outro token;
3. use apenas variável de ambiente local ou GitHub Secret.

Variável local:

```bash
export DIGITALOCEAN_API_TOKEN="dop_v1_..."
```

GitHub Secret:

```txt
DIGITALOCEAN_ACCESS_TOKEN
```

O workflow atual de deploy da aplicação não precisa desse token. Ele usa SSH. O token só é necessário para automações de infraestrutura DigitalOcean.

## 2. Configurar MCP local

Use o exemplo:

```txt
docs/runbooks/digitalocean-mcp.example.json
```

Serviços habilitados:

- `droplets`: criar/listar/inspecionar VPS.
- `networking`: firewall, DNS e rede.
- `volumes`: disco extra opcional.
- `spaces`: backup/storage externo opcional.
- `docs`: documentação oficial DigitalOcean.

Não habilitamos `apps` porque o deploy escolhido é VPS all-in-one com Docker Compose, não App Platform.

Depois de configurar o MCP no cliente, reinicie o cliente/IDE e confira se o servidor aparece em `/mcp`.

## 3. O que pedir ao agente via MCP

Use um prompt operacional assim:

```txt
Use o MCP da DigitalOcean em modo conservador.
Não delete recursos.
Crie ou valide:
- 1 Droplet Ubuntu 24.04
- região nyc3 ou tor1, conforme disponibilidade/preço
- tamanho mínimo 4 vCPU / 8 GB RAM / 160 GB SSD
- SSH key informada na minha conta
- firewall liberando somente 22/tcp, 80/tcp e 443/tcp
- DNS A para DOMINIO.com, api.DOMINIO.com e storage.DOMINIO.com apontando para o IP da VPS
Retorne IDs, IP público, região, tamanho e nomes dos recursos.
```

Para produção mais folgada:

```txt
Use 8 vCPU / 16 GB RAM se o custo couber.
Se o disco local for menor que 160 GB, crie/anexe um Volume e monte em /srv/clipbr antes do deploy.
```

## 4. Preparar a VPS criada pelo MCP

Entre como `root` usando a chave SSH inicial da Droplet:

```bash
ssh root@IP_DA_VPS
```

Rode o provisionamento:

```bash
curl -fsSL https://raw.githubusercontent.com/ORG/REPO/main/scripts/vps/provision-ubuntu.sh -o /tmp/provision-ubuntu.sh
bash /tmp/provision-ubuntu.sh
```

Se quiser usar uma chave pública específica para o deploy do GitHub:

```bash
DEPLOY_SSH_PUBLIC_KEY='ssh-ed25519 AAAA...' bash /tmp/provision-ubuntu.sh
```

O script cria o usuário `clipbr`, instala Docker/Compose, configura firewall básico e garante `authorized_keys` para o usuário de deploy.

## 5. Configurar `.env.production`

Na VPS:

```bash
sudo -iu clipbr
cd /srv/clipbr/app
cp .env.vps.example .env.production
chmod 600 .env.production
```

Preencha todos os valores reais. Em produção pública, não deixe:

- `DOMINIO.com`
- `CHANGE_ME_...`
- `TURNSTILE_BYPASS_TOKEN`

Se preferir gerenciar o env pelo GitHub Actions, gere:

```bash
base64 -w0 .env.production
```

No macOS:

```bash
base64 -i .env.production | tr -d '\n'
```

E salve em:

```txt
VPS_ENV_PRODUCTION_B64
```

## 6. Configurar GitHub Actions

Environment:

```txt
vps-production
```

Secrets obrigatórios:

```txt
VPS_HOST=IP_DA_VPS
VPS_USER=clipbr
VPS_SSH_KEY=<chave privada do deploy>
```

Se usar `digitalocean_mode=provision`, `VPS_HOST` pode ficar vazio: o workflow usa o IP retornado pela DigitalOcean. Se usar `off` ou `validate` com Droplet já existente, preencher `VPS_HOST` deixa o deploy mais explícito.

Secrets opcionais:

```txt
DIGITALOCEAN_ACCESS_TOKEN=<token novo da DigitalOcean>
VPS_ENV_PRODUCTION_B64=<.env.production base64>
GHCR_READ_TOKEN=<PAT se as imagens GHCR forem privadas>
VPS_PRODUCT_E2E_EMAIL=<usuário de smoke>
VPS_PRODUCT_E2E_PASSWORD=<senha de smoke>
VPS_PRODUCT_E2E_TURNSTILE_TOKEN=<token bypass temporário se usado>
```

Vars de repositório/organização:

```txt
VPS_AUTO_DEPLOY_DISABLED=false
VPS_USER=clipbr
VPS_APP_DIR=/srv/clipbr/app
VPS_SSH_PORT=22
VPS_PUBLIC_API_URL=https://api.DOMINIO.com
VPS_NEXT_PUBLIC_TURNSTILE_SITE_KEY=<site key>
NEXT_PUBLIC_TERMS_VERSION=terms-2026-06
NEXT_PUBLIC_PRIVACY_VERSION=privacy-2026-06
DIGITALOCEAN_MODE=validate
DIGITALOCEAN_DROPLET_ID=<id-do-droplet-existente>
DIGITALOCEAN_DROPLET_NAME=<nome-do-droplet-existente>
DIGITALOCEAN_DROPLET_REGION=nyc3
DIGITALOCEAN_DROPLET_SIZE=s-4vcpu-8gb
DIGITALOCEAN_SSH_KEY_IDS=<id-ou-fingerprint-da-chave-ssh-na-digitalocean>
DIGITALOCEAN_FIREWALL_NAME=<firewall-existente-se-houver>
DIGITALOCEAN_DOMAIN=DOMINIO.com
DIGITALOCEAN_MANAGE_DNS=false
```

Push na `main` faz deploy pela esteira quando o gate passa. Use `VPS_AUTO_DEPLOY_DISABLED=true` apenas para pausar temporariamente esse deploy automático.

Modos DigitalOcean do workflow:

| Modo | O que faz |
| --- | --- |
| `off` | Não chama DigitalOcean; usa `VPS_HOST` diretamente. |
| `validate` | Usa `doctl` para validar Droplet existente/firewall/DNS antes do SSH deploy. Não instala nada no servidor. |
| `adopt` | Usa Droplet existente e roda bootstrap via SSH root para instalar Docker/criar usuário `clipbr`. |
| `provision` | Cria a Droplet se ela não existir, provisiona Docker/usuário `clipbr` via SSH root, reconcilia firewall/DNS e depois faz deploy. |

O MCP local pode ajudar o agente a inspecionar/criar recursos pela conversa. O GitHub Actions não usa MCP; dentro do runner, usamos `doctl` porque é determinístico, auditável e funciona sem manter um servidor MCP conectado.

Para Droplet existente:

- use `DIGITALOCEAN_DROPLET_ID` quando possível;
- se já existe Docker/Compose/usuário `clipbr`, use `digitalocean_mode=validate`;
- se ainda precisa preparar o SO, use `digitalocean_mode=adopt`; nesse modo a chave privada em `VPS_SSH_KEY` precisa acessar `root` uma vez para executar `scripts/vps/provision-ubuntu.sh`;
- use `digitalocean_mode=provision` somente para criar Droplet novo.

## 7. Primeiro deploy

No GitHub Actions, rode:

```txt
Workflow: VPS CI/CD
deploy=true
digitalocean_mode=validate
run_product_e2e=false
run_5g=false
```

Depois rode:

```txt
deploy=true
digitalocean_mode=validate
run_product_e2e=true
run_5g=false
```

Por fim, em janela controlada:

```txt
deploy=true
digitalocean_mode=validate
run_product_e2e=false
run_5g=true
```

Se precisar pausar temporariamente o deploy automático da `main`, altere:

```txt
VPS_AUTO_DEPLOY_DISABLED=true
```

## 8. Responsabilidade de cada ferramenta

| Ferramenta | Papel |
| --- | --- |
| DigitalOcean MCP | Criar/inspecionar Droplet, firewall, DNS, volumes e Spaces |
| `doctl` no GitHub Actions | Provisionar/validar Droplet de forma reprodutível durante o workflow |
| GitHub Actions | Gate, build, push de imagens, deploy e smoke |
| SSH | Canal de deploy na VPS |
| Docker Compose | Runtime de produção all-in-one |
| Caddy | TLS e proxy público |

Essa separação evita que uma falha do MCP impeça deploys reprodutíveis.
