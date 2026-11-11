# Como testar

Três níveis: **simulador** (sem TikTok), **eventos na mão** (para testar cada
regra) e **live real**. No fim, os testes automatizados e os problemas comuns.

---

## 1. Teste rápido com o simulador

```powershell
cd tiktok-live-game
npm install
npm run simulate
```

Abra **http://127.0.0.1:8787**. Você deve ver:

- personagem mudando de emoji quando cai presente/curtida;
- balão de fala quando o chat é respondido ou alguém manda presente caro;
- HUD com moedas, curtidas, **chat respondido (x/10)**, espectadores e meta;
- ranking de doadores e log de eventos.

O simulador gera eventos a cada 1,2 s (chat, curtidas, presentes, follows,
espectadores) e força um presente caro a cada 25 eventos. Para acelerar:

```powershell
$env:SIM_INTERVAL_MS=300
$env:SIM_EXPENSIVE_EVERY=8
npm run simulate
```

Para encerrar: `Ctrl+C`. A simulação **não** grava `data/session.json`.

---

## 2. Testar cada regra na mão

Com o servidor rodando (`npm run simulate` em outro terminal), use a rota
`POST /api/simulate`. Ela só aceita chamadas locais (ou exige `SIM_TOKEN`).

### Presente caro (> 1000 moedas)

```powershell
$body = @{ events = @(
  @{ type='gift'; user=@{ id='9'; nickname='Nanda' }; giftName='Leão'; diamonds=600 }
) } | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/simulate `
  -ContentType 'application/json' -Body $body
```

`600 diamantes × 2 moedas = 1200 moedas` → animação épica **e** fala:
"Nanda!!! Leão de 1200 moedas?! Você é uma lenda!". Confira em `/state`:
`totals.coins = 1200` e `leaderboard[0].user.nickname = Nanda`.

### Curtidas (marco de 100)

```powershell
$body = @{ events = @(
  @{ type='like'; count=100; user=@{ id='1'; nickname='Bia' } }
) } | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/simulate `
  -ContentType 'application/json' -Body $body
```

`/state` → `like.total = 100`, `like.milestone = 1`, `nextMilestone = 200`.
Mande `count=250` de uma vez para ver três marcos (duas animações extras).

### Chat com 4 respostas em 10

```powershell
$events = 1..10 | ForEach-Object {
  @{ type='chat'; text="mensagem numero $_"; user=@{ id="$($_)"; nickname="User$_" } }
}
$body = @{ events = $events } | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/simulate `
  -ContentType 'application/json' -Body $body

Start-Sleep -Seconds 3
(Invoke-RestMethod http://127.0.0.1:8787/state).chat
```

Resultado esperado: `repliesInWindow = 4`, `messagesInWindow = 10`,
`replyRate = 0.4`. No overlay, o HUD mostra **4 / 10** e o log mostra as falas
espaçadas (~800 ms), com a 5ª e a 6ª chegando depois do cooldown de 2,5 s.
Se enviar 10 mensagens de novo (de outros usuários), a janela desliza e a cota
é recalculada.

### Combo de presente (agrupamento)

```powershell
$body = @{ events = @(
  @{ type='gift'; user=@{ id='3'; nickname='Gui' }; giftName='Corações'; diamonds=100; repeatCount=1; streakable=$true; comboEnd=$false },
  @{ type='gift'; user=@{ id='3'; nickname='Gui' }; giftName='Corações'; diamonds=100; repeatCount=3; streakable=$true; comboEnd=$true }
) } | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/simulate `
  -ContentType 'application/json' -Body $body
```

Deve sair **uma** ação de 600 moedas (`100 × 3 × 2`), não três.

### Meta de moedas

```powershell
$body = @{ events = @(
  @{ type='gift'; user=@{ id='4'; nickname='Duda' }; giftName='Galáxia'; diamonds=3000 }
) } | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/simulate `
  -ContentType 'application/json' -Body $body
```

`3000 × 2 = 6000` → passa da meta padrão (5000): fogos + fala, e
`goal.reached = true` no `/state`.

### Social e espectadores

```powershell
$body = @{ events = @(
  @{ type='follow'; user=@{ id='5'; nickname='Juh' } },
  @{ type='share'; user=@{ id='6'; nickname='Rafa' } },
  @{ type='subscribe'; user=@{ id='7'; nickname='Bia' } },
  @{ type='viewers'; count=321 }
) } | ConvertTo-Json -Depth 5
```

### Ver o estado e a configuração

```powershell
Invoke-RestMethod http://127.0.0.1:8787/state   | ConvertTo-Json -Depth 5
Invoke-RestMethod http://127.0.0.1:8787/config  | ConvertTo-Json -Depth 5
Invoke-RestMethod http://127.0.0.1:8787/health  | ConvertTo-Json -Depth 5
```

---

## 3. Testar o visual / WebSocket

Abra o console do navegador (F12) na página do overlay e cole:

```js
const ws = new WebSocket('ws://127.0.0.1:8787/ws');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

Dispare um presente em outro terminal e veja chegar `hello` (ao conectar),
`action` (na hora) e `state` (até 2×/s). O contrato completo, com exemplos de
cada ação, está em [`CONTRATO-OVERLAY.md`](CONTRATO-OVERLAY.md).

Dica: 4 balões de chat chegando juntos é o comportamento esperado da cota
4/10; use `seq` para deduplicar se reconectar.

---

## 4. Testar com a live real

1. Copie `.env.example` para `.env`.
2. Preencha:
   - `TIKTOK_USERNAME=seuusuario`
   - `TIKTOK_SIGN_API_KEY=...` (chave gratuita em https://eulerstream.com)
3. A conta precisa estar **ao vivo**.
4. Rode:

   ```powershell
   npm start
   ```

5. Confira no log `Conexão: connected` e abra o overlay.
6. Peça para alguém (ou uma segunda conta) mandar um presente, curtir e
   escrever no chat.

Sem `TIKTOK_SIGN_API_KEY`, a conexão costuma falhar com
`Failed to retrieve Room ID from all sources` — é limite de assinatura, não bug
do jogo. Para testar sem live, use o simulador.

---

## 5. Testes automatizados

```powershell
npm test          # compila e roda os 48 testes
npm run typecheck # só a checagem de tipos
```

Os testes usam relógio falso e cobrem:

- 4/10 em rajada, janela deslizando, teto de 6, cooldowns e fila cheia;
- combos, faixas de doação, limite exato de 1000 moedas, fala do presente caro;
- marcos de curtidas e lotes grandes;
- meta, ranking e restauração de sessão;
- WebSocket (`hello`, ações), `/api/simulate` e `ping/pong`.

---

## 6. Problemas comuns

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| `EADDRINUSE` | porta 8787 ocupada | `npm start -- --port=9000` |
| Página em branco/desconectada | servidor parado ou outra porta | veja o log e use a URL/porta corretas |
| Nenhum evento no simulador | `SIM_INTERVAL_MS` muito alto | use `300` |
| "presente caro não dispara" | valor em moedas ≤ 1000 | use `diamonds ≥ 501` (×2) ou `coins.overrides` |
| Chat responde pouco | é o esperado (4 a 6 de 10) | ajuste `chat` em `config/game.json` |
| `Failed to retrieve Room ID` | live offline ou sem chave Euler | confira o @, a live e a chave |
| Overlay de outro domínio não conecta | CORS/WS liberado, mas host/porta errados | use `ws://IP:8787/ws` |
