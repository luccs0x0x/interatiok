# Contrato do overlay (WebSocket)

Este é o documento para quem vai construir o **visual**. O motor entrega eventos
prontos; o overlay só precisa decidir como animar. Nada de regra de negócio aqui.

- **URL:** `ws://127.0.0.1:8787/ws` (ou o host/porta configurados)
- **Formato:** JSON, um objeto por mensagem
- **Versão do protocolo:** `v: 1` em todas as mensagens
- **Autenticação:** nenhuma (servidor local por padrão)
- **Cliente → servidor:** opcional, apenas `{"type":"ping"}` (recebe `pong`)

Ao conectar, o servidor manda **`hello`** com o estado completo e os limites do
jogo. Depois disso chegam **`action`** (na hora) e **`state`** (no máximo 2×/s,
com throttle de `overlay.stateThrottleMs`).

---

## 1. `hello`

```json
{
  "v": 1,
  "type": "hello",
  "serverTime": 1762951200000,
  "state": { "...": "veja seção 3" },
  "config": {
    "thresholds": {
      "expensiveGiftCoins": 1000,
      "likeStep": 100,
      "goalCoins": 5000,
      "goalEnabled": true
    },
    "chat": {
      "windowSize": 10,
      "minRepliesPerWindow": 4,
      "maxRepliesPerWindow": 6,
      "cooldownMs": 2500,
      "minReplyGapMs": 800
    },
    "tiers": [
      { "id": "bronze", "minCoins": 1, "animation": "wave", "intensity": 1 },
      { "id": "prata", "minCoins": 100, "animation": "cheer", "intensity": 2 },
      { "id": "ouro", "minCoins": 500, "animation": "dance", "intensity": 3 },
      { "id": "diamante", "minCoins": 1000, "animation": "celebrate", "intensity": 4 }
    ],
    "animations": {
      "likeMilestone": "hype",
      "expensiveGift": "bow",
      "goal": "fireworks"
    }
  }
}
```

Use `config` para montar textos de HUD ("faltam X moedas para o presente épico")
e para saber a meta de respostas do chat.

---

## 2. `action` — o que animar

```json
{
  "v": 1,
  "type": "action",
  "seq": 42,
  "id": "action-42",
  "ts": 1762951200123,
  "action": { "kind": "character.act", "...": "..." }
}
```

- `seq` é crescente e único na sessão → **use para deduplicar** se reconectar.
- `ts` é o horário do evento no servidor.
- Existem **dois tipos** de ação: `character.act` (animação) e `character.say`
  (balão de fala).

### 2.1 `character.act`

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `reason` | string | por que aconteceu: `donation`, `expensive_gift`, `like_milestone`, `follow`, `share`, `subscribe`, `join`, `goal` |
| `animation` | string | nome semântico da animação (ver catálogo abaixo) |
| `intensity` | 1–5 | intensidade/escala sugerida |
| `user` | objeto? | quem disparou (`userId`, `username`, `nickname`, `avatarUrl?`) |
| `data` | objeto | dados do evento (moedas, tier, gift, marco...) |

**Doação (presente de 100 moedas):**

```json
{
  "kind": "character.act",
  "reason": "donation",
  "animation": "cheer",
  "intensity": 2,
  "user": { "userId": "1001", "username": "bia_tv", "nickname": "Bia" },
  "data": { "coins": 200, "tier": "prata", "gift": "Perfume", "giftId": "5658", "repeat": 2 }
}
```

**Presente caro (> 1000 moedas):** o mesmo formato, com
`reason: "expensive_gift"`, `animation: "bow"`, `intensity: 5`. Esse evento
**não** vem acompanhado de `donation`; ele substitui a ação comum.

**Marco de curtidas:**

```json
{
  "kind": "character.act",
  "reason": "like_milestone",
  "animation": "hype",
  "intensity": 3,
  "user": { "userId": "1002", "username": "lucasplays", "nickname": "Lucas" },
  "data": { "milestone": 7, "step": 100, "totalLikes": 743 }
}
```

**Meta batida:**

```json
{
  "kind": "character.act",
  "reason": "goal",
  "animation": "fireworks",
  "intensity": 5,
  "data": { "coins": 5120, "target": 5000 }
}
```

Sociais usam `reason` = `follow` / `share` / `subscribe` / `join`, sem `data`.

### 2.2 `character.say`

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `reason` | string | `chat`, `expensive_gift`, `donation`, `follow`, `subscribe`, `goal` |
| `text` | string | fala pronta, em pt-BR (sem markdown) |
| `emotion` | string | `neutral`, `happy`, `excited`, `grateful`, `surprised`, `playful`, `shy` |
| `user` | objeto? | interlocutor (no chat, quem mandou a mensagem) |
| `data` | objeto | `intent` (chat), `chatMessageId`, dados do presente... |

```json
{
  "kind": "character.say",
  "reason": "chat",
  "text": "Oi, Bia! Chegou na hora certa! 💜",
  "emotion": "happy",
  "user": { "userId": "1001", "username": "bia_tv", "nickname": "Bia" },
  "data": { "chatMessageId": "745123...", "intent": "greeting" }
}
```

```json
{
  "kind": "character.say",
  "reason": "expensive_gift",
  "text": "Nanda!!! Leão de 1200 moedas?! Você é uma lenda! 👑",
  "emotion": "surprised",
  "user": { "userId": "1009", "username": "nanda", "nickname": "Nanda" },
  "data": { "coins": 1200, "tier": "diamante", "gift": "Leão", "repeat": 1 }
}
```

### 2.3 Catálogo de animações

Os nomes são acordados entre motor e visual. O padrão é:

| `animation` | Ideia |
| --- | --- |
| `wave` | aceno / reação leve |
| `cheer` | comemoração curta |
| `dance` | dança (doação média) |
| `celebrate` | comemoração grande (doação alta, assinatura) |
| `hype` | pulo/energia de curtidas |
| `bow` | agradecimento dramático (presente caro) |
| `fireworks` | efeito de meta |
| `idle` | evento discreto (entrada) |

São configuráveis em `config/game.json` — se o visual só tiver outras animações,
basta trocar os nomes lá. **Ignore animações desconhecidas** em vez de quebrar.

---

## 3. `state` — HUD

```json
{
  "v": 1,
  "type": "state",
  "state": {
    "protocol": 1,
    "startedAt": 1762951000000,
    "updatedAt": 1762951200000,
    "connection": {
      "status": "connected",
      "room": "sala-simulada",
      "viewers": 321,
      "message": null
    },
    "totals": {
      "coins": 4380,
      "gifts": 27,
      "likes": 743,
      "messages": 58,
      "replies": 24,
      "followers": 5,
      "shares": 2,
      "subscribers": 1
    },
    "like": { "total": 743, "milestone": 7, "nextMilestone": 800, "progress": 0.43 },
    "chat": {
      "windowSize": 10,
      "messagesInWindow": 10,
      "repliesInWindow": 4,
      "target": 4,
      "totalMessages": 58,
      "totalReplies": 24,
      "totalSkipped": 30,
      "totalDropped": 4,
      "replyRate": 0.4
    },
    "goal": { "enabled": true, "targetCoins": 5000, "reached": false, "progress": 0.876 },
    "leaderboard": [
      { "user": { "userId": "1009", "username": "nanda", "nickname": "Nanda" }, "coins": 1200, "gifts": 2 }
    ],
    "lastAction": { "ts": 1762951199000, "kind": "character.say", "reason": "chat" }
  }
}
```

- `chat.repliesInWindow` / `chat.messagesInWindow` é o "4 de 10" em tempo real.
- `goal.progress` pode passar de 1 se a meta foi superada.
- `leaderboard` já vem ordenado e limitado a 5.
- `connection.status`: `connecting`, `connected`, `disconnected` ou `error`.

---

## 4. Como consumir (sugestão de fila)

Ações podem chegar em rajada (ex.: 4 respostas de chat + um marco de curtidas).
Recomendado:

1. **Fila de animações** com prioridade:
   `goal`/`expensive_gift` (5) > `like_milestone` (3) > `donation` (tier/intensidade)
   > `subscribe`/`follow`/`share` (2) > `chat` (1).
2. Não interromper uma animação de prioridade maior por uma menor; enfileire.
3. Limite a fila (ex.: 3 itens) e descarte a menor prioridade quando encher.
4. Balão de fala: exiba um por vez, 6–7 s, ou até a próxima fala; dê preferência
   a `expensive_gift` e `goal` (substituem a fala atual).
5. Deduplique por `message.seq` ao reconectar.

### Esqueleto em JavaScript

```js
const socket = new WebSocket('ws://127.0.0.1:8787/ws');
let lastSeq = 0;

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'hello') return renderState(message.state);
  if (message.type === 'state') return renderState(message.state);
  if (message.type !== 'action') return;

  if (message.seq <= lastSeq) return; // duplicata após reconexão
  lastSeq = message.seq;

  const action = message.action;
  if (action.kind === 'character.act') playAnimation(action.animation, action.intensity, action.reason);
  else showBubble(action.text, action.emotion, action.reason);
};
```

---

## 5. HTTP auxiliar

| Rota | Conteúdo |
| --- | --- |
| `GET /health` | `{ ok, uptimeSeconds, clients, connection }` |
| `GET /state` | o mesmo objeto de `state` |
| `GET /config` | os mesmos limites de `hello.config` |
| `POST /api/simulate` | injeta eventos (teste do visual sem live) |

Se o overlay rodar em outra máquina/origem, o CORS já está liberado (`*`) e o
WebSocket aceita qualquer origem. Em produção na rede, coloque autenticação na
frente (o servidor não tem login).
