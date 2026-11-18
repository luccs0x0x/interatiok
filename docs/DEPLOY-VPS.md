# Rodar numa VPS (24/7)

**Sim — dá para deixar o motor rodando na VPS.** Ele é um serviço Node sem
interface gráfica: fica conectado ao Webcast, processa os eventos e serve o
overlay por HTTP/WebSocket. A **transmissão da live em si continua saindo do seu
celular/PC**; a VPS só mantém o jogo online.

```
TikTok LIVE  ──Webcast──►  VPS (motor + WebSocket)  ──wss──►  OBS / overlay no seu PC
```

Requisitos: Ubuntu 22.04/24.04, 1 vCPU, 512 MB–1 GB de RAM, 10 GB de disco.
Funciona igual em Debian, Fedora ou qualquer distro com Node 22 (ou Docker).

---

## Opção A — systemd + Caddy (recomendada)

### 1. Instalar o Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # v22.x
```

### 2. Criar o usuário e baixar o projeto

```bash
sudo adduser --disabled-password --gecos "" game
sudo mkdir -p /opt/tiktok-live-game
sudo chown game:game /opt/tiktok-live-game

sudo -u game git clone https://github.com/luccs0x0x/interatiok.git /opt/tiktok-live-game
```

### 3. Instalar, compilar e configurar

```bash
sudo -iu game
cd /opt/tiktok-live-game
npm ci
npm run build
cp .env.example .env
nano .env
```

Conteúdo mínimo do `.env` de produção:

```env
TIKTOK_USERNAME=seuusuario
TIKTOK_SIGN_API_KEY=sua_chave_eulerstream
HOST=127.0.0.1
PORT=8787
SIM_TOKEN=uma-string-longa-e-aleatoria
LOG_LEVEL=info
```

Desligue a rota de simulação em `config/game.json`:

```json
"overlay": { "allowSimulate": false }
```

> Por que desligar: atrás do Caddy, toda requisição chega como `127.0.0.1`, e a
> rota `/api/simulate` aceitaria chamadas locais. Com `allowSimulate: false` ela
> responde 403 sempre.

### 4. Instalar como serviço

```bash
exit   # volta para o seu usuário com sudo
sudo cp /opt/tiktok-live-game/deploy/tiktok-game.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tiktok-game
systemctl status tiktok-game --no-pager
```

Logs ao vivo:

```bash
sudo journalctl -u tiktok-game -f
```

Você deve ver `HTTP/overlay`, `WebSocket` e `Conexão: connected`.

### 5. HTTPS/WSS com Caddy

Aponte um registro DNS **A** (`game.seudominio.com`) para o IP da VPS e:

```bash
sudo apt install -y caddy
sudo cp /opt/tiktok-live-game/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile    # troque o domínio
sudo systemctl reload caddy
```

O Caddy emite o certificado e já faz o upgrade do WebSocket. O overlay fica em
`https://game.seudominio.com` e o WebSocket em `wss://game.seudominio.com/ws`.

### 6. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

**Não abra a 8787.** Ela deve escutar só em `127.0.0.1` e ser acessada via proxy.

### 7. Conferir

```bash
curl -s https://game.seudominio.com/health
curl -s https://game.seudominio.com/state
```

Abra o overlay no navegador (ou no OBS) e peça para alguém mandar um presente.

---

## Opção B — Docker Compose

Na VPS, com Docker instalado:

```bash
git clone https://github.com/luccs0x0x/interatiok.git
cd interatiok
cp .env.example .env
nano .env                 # TIKTOK_USERNAME + TIKTOK_SIGN_API_KEY + SIM_TOKEN
mkdir -p data

docker compose up -d --build
docker compose ps
docker compose logs -f
```

O `docker-compose.yml` já:

- publica a porta **apenas no loopback** (`127.0.0.1:8787`);
- força `HOST=0.0.0.0` dentro do contêiner;
- monta `./data` para preservar `session.json`;
- reinicia sozinho (`restart: unless-stopped`) e tem healthcheck.

Se aparecer erro de permissão no `data/`:

```bash
sudo chown -R 1000:1000 data
```

Para HTTPS, instale o Caddy no **host** (não no compose) e use o mesmo
`deploy/Caddyfile` apontando para `127.0.0.1:8787`.

Atualizar:

```bash
git pull
docker compose up -d --build
```

---

## O que fica onde

| Item | Onde | Observação |
| --- | --- | --- |
| Motor + WebSocket | VPS | `127.0.0.1:8787` atrás do Caddy |
| Overlay (HTML) | VPS ou seu PC | `https://game.seudominio.com` |
| OBS/browser source | Seu PC | use a URL `https://` (não `file://`) |
| Lives | TikTok | transmitidas pelo celular/PC |

Se o seu overlay for uma página **https** em outro domínio, o WebSocket também
precisa ser **wss://** (navegador bloqueia `ws://` em página segura). O servidor
já aceita qualquer origem (CORS `*`), então basta apontar para
`wss://game.seudominio.com/ws`.

---

## Atualizar o código

```bash
cd /opt/tiktok-live-game
sudo -u game git pull
sudo -u game npm ci
sudo -u game npm run build
sudo systemctl restart tiktok-game
```

---

## Persistência e backup

- Totais, ranking e meta ficam em `data/session.json` (só em modo live; o
  simulador não grava).
- Backup: `cp /opt/tiktok-live-game/data/session.json ~/session-backup.json`.
- Para "zerar" a sessão: pare o serviço, apague o arquivo e suba de novo.

---

## Segurança

- Mantenha `chmod 600 .env` (contém a chave do Euler e, se usar, o cookie de
  sessão do TikTok).
- `/state` e `/ws` não têm login: quem souber a URL vê o placar e o chat
  processado. Use um subdomínio difícil de adivinhar ou coloque autenticação
  básica no Caddy.
- Não exponha a 8787 na internet e não comite o `.env`.

---

## Limites do TikTok (importante)

- O `tiktok-live-connector` é **não oficial**; mudanças no Webcast podem exigir
  atualização da biblioteca (`npm update tiktok-live-connector`).
- A chave do Euler Stream tem limite por IP/plano. Em VPS, IPs de datacenter
  podem ser mais restritos; se aparecer `Failed to retrieve Room ID` ou erro de
  assinatura, confira a chave e considere um plano pago.
- O processo já reconecta sozinho a cada 30 s quando a live cai; para trocar de
  live, ajuste `TIKTOK_USERNAME` e reinicie o serviço.
- Uma instância atende **uma** live. Para duas, rode dois processos em portas
  diferentes (dois serviços systemd / dois containers).

---

## Custo aproximado

VPS de 1 vCPU/1 GB: US$ 4–6/mês (Hetzner, DigitalOcean, Vultr). Domínio:
~US$ 10/ano. O consumo do motor é baixo (dezenas de MB de RAM, CPU ociosa entre
eventos).
