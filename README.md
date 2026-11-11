# TikTok Live Game — motor de interação

Motor de jogo para **TikTok LIVE**: transforma presentes, curtidas e mensagens do
chat em ações para um personagem. O código cuida de toda a regra de negócio e da
conexão; o visual (personagem, cenário, animações) consome um WebSocket e pode ser
feito em qualquer ferramenta — OBS/browser source, Unity, Godot, After Effects etc.

> **Sobre o link de Mini Games:** a documentação de *Mini Games Integration
> Workflow* trata de jogos publicados **dentro** do TikTok (SDK de mini games,
> login silencioso, anúncios, compras). Reagir a presentes/curtidas/chat de uma
> **live** é outra coisa: usa-se o TikTok LIVE (Webcast). É o que este projeto faz,
> através da biblioteca de código aberto `tiktok-live-connector` (não oficial).

---

## Mecânicas implementadas

| Evento da live | Regra | O que o personagem faz |
| --- | --- | --- |
| **Doação** (qualquer presente) | valor em moedas define a faixa (`bronze`, `prata`, `ouro`, `diamante`) | animação da faixa + entra no ranking e na meta |
| **Presente caro** (acima de 1000 moedas) | `moedas > expensiveGift.minCoinsExclusive` | animação épica (`bow`, força 5) **e fala nominal** para quem mandou |
| **Curtidas** | a cada 100 curtidas acumuladas (`likes.step`) | animação de hype (`hype`), com o número do marco |
| **Chat** | cooldown global de 2,5 s + **garantia de 4 respostas a cada 10 mensagens** | balão de fala respondendo à pessoa |
| **Follow / share / assinatura** | eventos sociais | animação (assinatura também ganha fala) |
| **Meta de moedas** | total de moedas ≥ `donation.goal.targetCoins` | fogos + fala de comemoração (uma vez por sessão) |

Os presentes de **combo** (streak) são agrupados: um presente de 5 unidades vira
**uma** ação de 5× o valor, não cinco animações.

### A garantia de "pelo menos 4 das 10 mensagens"

O `ChatScheduler` mantém uma janela deslizante com as últimas 10 mensagens
válidas e decide, a cada mensagem nova:

1. **Cota mínima:** se a janela tem menos de 4 respostas, a próxima resposta é
   obrigatória e **fura o cooldown global** (a garantia tem prioridade), mas
   respeita o piso de 800 ms entre falas (`chat.minReplyGapMs`).
2. **Teto:** no máximo 6 respostas por janela, para o personagem não responder
   tudo e virar um bot repetitivo.
3. **Cooldown global** de 2,5 s entre duas respostas quaisquer.
4. **Cooldown por pessoa** de 20 s (com um piso de 1,2 s quando a cota força),
   para ninguém monopolizar o personagem.
5. Mensagens curtas, comandos (`!...`) e repetições da mesma pessoa em 30 s são
   descartados e **não contam** na janela.

Com 10 mensagens chegando de uma vez, saem 4 respostas espaçadas em ~800 ms
(piso `chat.minReplyGapMs`), cumprindo a cota em ~2,4 s; as outras esperam o
cooldown. Com o chat calmo, as respostas são espaçadas naturalmente. À medida
que a janela desliza, a cota é recalculada e as respostas em fila mantêm a
proporção de 4/10.

Os números ficam em `config/game.json` (bloco `chat`) e o estado atual
(`repliesInWindow`, `messagesInWindow`, `replyRate`, `target`) vai no snapshot do
WebSocket para o visual mostrar "4/10 respondidas".

---

## Rodando

Requisitos: **Node.js 20+**.

```bash
npm install

# 1) Sem TikTok: eventos falsos para desenvolver o visual
npm run simulate

# 2) Com a live real
npm start -- --room=@seuusuario
```

Depois abra **http://127.0.0.1:8787** — há um overlay de debug (propositalmente
sem design) que mostra o personagem, o balão de fala, HUD, ranking e o log de
eventos. Ele serve como referência de consumo do WebSocket.

Os comandos `start` e `simulate` compilam o TypeScript automaticamente antes de
rodar (o `build` leva ~2 s).

Guia passo a passo de testes (simulador, cada regra via API, WebSocket e live
real): [`docs/COMO-TESTAR.md`](docs/COMO-TESTAR.md).

Outros comandos:

```bash
npm test                                  # 48 testes (regras, combos, servidor, sessão)
npm start -- --simulate --duration=20     # simulação com tempo limitado
npm start -- --room=@user --port=9000     # outra porta
```

### Conectar no TikTok LIVE

1. Crie uma chave gratuita no [Euler Stream](https://eulerstream.com) (o
   `tiktok-live-connector` v2 usa essa assinatura para abrir o WebSocket).
2. Configure o `.env` (copie de `.env.example`):

   ```env
   TIKTOK_SIGN_API_KEY=sua_chave
   TIKTOK_USERNAME=seuusuario
   ```

3. A conta precisa estar **ao vivo** no momento da conexão.

Sem chave, a biblioteca tenta uma chave pública compartilhada e costuma esbarrar
em limite de requisições. O `sessionid` (cookie de uma conta logada) é opcional e
melhora a autenticação — trate como segredo e nunca comite.

---

## Configuração (`config/game.json`)

| Chave | Padrão | Para que serve |
| --- | --- | --- |
| `coins.perDiamond` | `2` | converte diamantes (formato do TikTok) em moedas (preço do presente) |
| `coins.overrides` | `{}` | valor fixo por `giftId`, ex.: `{ "5655": 1500 }` |
| `donation.tiers` | 4 faixas | `minCoins` → `animation` + `intensity` |
| `donation.speakFromCoins` | `0` | a partir de quantas moedas o personagem também agradece falando (0 = nunca) |
| `donation.goal.targetCoins` | `5000` | meta de moedas da sessão |
| `expensiveGift.minCoinsExclusive` | `1000` | limite do "presente caro" (estritamente maior) |
| `likes.step` | `100` | quantas curtidas valem uma ação |
| `chat.minRepliesPerWindow` | `4` | cota mínima por janela |
| `chat.windowSize` | `10` | tamanho da janela deslizante |
| `chat.maxRepliesPerWindow` | `6` | teto por janela |
| `chat.cooldownMs` | `2500` | intervalo mínimo entre respostas |
| `chat.minReplyGapMs` | `800` | piso entre falas mesmo quando a cota força |
| `chat.perUserCooldownMs` | `20000` | cooldown por pessoa |
| `gifts.comboFlushMs` | `1500` | tempo sem novos incrementos para fechar o combo |
| `overlay.port` | `8787` | porta do HTTP/WebSocket |
| `session.persist` | `true` | retoma totais/ranking após reiniciar |

As falas do personagem ficam em `config/lines.pt-BR.json` (persona, intents,
agradecimentos, meta). É possível usar um LLM compatível com Chat Completions:

```env
LLM_API_KEY=...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

Sem chave (ou se o modelo falhar/estourar o tempo), o personagem usa as falas
locais — a live nunca trava esperando resposta.

---

## Arquitetura

```
TikTok Webcast ──► TikTokSource ─┐
                                 ├──► GameEngine ──► GameAction ──► GameServer ──► WebSocket ──► overlay
Simulador ──────► SimulatedSource┘        │                              │
                                          └── GameState (HUD) ───────────┘
```

- `src/engine/` — regras: `gameEngine.ts` (orquestra), `chatScheduler.ts`
  (garantia 4/10), `giftCombiner.ts` (combos), `responder.ts` + `llm.ts` (falas).
- `src/live/` — `tiktokSource.ts` (Webcast → eventos normalizados) e
  `simulatedSource.ts`.
- `src/server/` — HTTP, WebSocket e overlay de debug.
- `src/state/` — persistência da sessão em `data/session.json`.
- `src/clock.ts` — relógio injetável: os testes simulam cooldowns e combos sem
  esperar em tempo real.

O contrato do WebSocket (mensagens, ações e estado) está em
[`docs/CONTRATO-OVERLAY.md`](docs/CONTRATO-OVERLAY.md). É o que a IA/ferramenta
que fizer o visual precisa ler.

---

## API HTTP

| Rota | Descrição |
| --- | --- |
| `GET /` | overlay de debug |
| `GET /health` | status da conexão e clientes WebSocket |
| `GET /state` | snapshot do estado (moedas, curtidas, chat, ranking) |
| `GET /config` | limites públicos (para montar HUD/metas) |
| `POST /api/simulate` | injeta eventos para testar (só loopback, ou com `SIM_TOKEN`) |

```bash
# testa o presente caro sem esperar a live
curl -X POST http://127.0.0.1:8787/api/simulate \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"gift","user":{"id":"9","nickname":"Nanda"},"giftName":"Leão","diamonds":600}]}'
```

---

## Testes

`npm test` cobre as regras de verdade, com relógio falso:

- **4/10**: rajada, janela deslizando, teto de 6, cooldown, piso por pessoa,
  duplicatas/comandos, fila cheia.
- **Presentes**: faixas, valor por diamante, override por presente, combo
  agregado, limite exato de 1000 moedas, presente caro + fala.
- **Curtidas**: acumulado entre lotes, múltiplos marcos, lote gigante.
- **Social e meta**: follow/share/assinatura, meta única, ranking.
- **Servidor**: `hello`, transmissão de ações, `/api/simulate` (inclusive 403 com
  token), `ping/pong`.
- **Sessão**: debounce da gravação, retomada após restart e arquivo corrompido.

---

## Limitações e cuidados

- A conexão usa uma biblioteca **não oficial** que fala com o Webcast. O TikTok
  pode mudar o protocolo a qualquer momento; o adaptador isola esse risco em um
  único arquivo (`src/live/tiktokSource.ts`).
- O valor dos presentes é convertido de **diamantes** para **moedas** (`×2` por
  padrão). Os presentes mudam de preço; use `coins.overrides` se precisar de
  precisão.
- As respostas do personagem são **balões no overlay**. O projeto **não envia
  mensagens no chat do TikTok** — isso exigiria autenticação de conta e está
  sujeito às regras da plataforma.
- Respeite os Termos do TikTok e a LGPD: o projeto guarda apenas dados públicos
  (apelido, @, id) e totais agregados. Não use para spam, sorteio não autorizado
  ou promessas de dinheiro.
- Rode o servidor em `127.0.0.1` (padrão). Se expor na rede, proteja
  `/api/simulate` com `SIM_TOKEN` e coloque autenticação na frente do WebSocket.
