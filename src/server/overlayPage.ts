/**
 * Página de debug do overlay — feita para *verificar* o motor, não para ser o
 * visual final. É uma referência mínima de como consumir o WebSocket:
 * anima um emoji na ação, mostra o balão na fala, HUD, ranking e log.
 */
export function overlayPage(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TikTok Live Game — overlay de debug</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d0f17; color: #e8eaf2; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid #232838; font-size: 13px; flex-wrap: wrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #666; }
  .dot.on { background: #39d98a; box-shadow: 0 0 8px #39d98a; }
  .hint { margin-left: auto; color: #8b93a7; }
  main { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; padding: 16px; max-width: 1180px; margin: 0 auto; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  .stage { position: relative; min-height: 360px; border: 1px solid #232838; border-radius: 16px;
           background: radial-gradient(circle at 50% 35%, #1b2140, #0d0f17 70%);
           display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; overflow: hidden; }
  .character { font-size: 88px; line-height: 1; transition: transform .14s ease; }
  .character.bump { transform: scale(1.22); }
  .anim { color: #8b93a7; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
  .bubble { position: absolute; left: 50%; top: 16px; transform: translateX(-50%); max-width: 86%;
            background: #fff; color: #10131c; border-radius: 14px; padding: 10px 14px; font-size: 15px;
            line-height: 1.35; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .bubble.show { opacity: 1; }
  .panel { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .card { border: 1px solid #232838; border-radius: 12px; padding: 10px 12px; background: #121623; }
  .card h3 { margin: 0 0 4px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b93a7; font-weight: 600; }
  .big { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  small { color: #8b93a7; }
  .goal { border: 1px solid #232838; border-radius: 12px; padding: 10px 12px; background: #121623; }
  .goal-head { display: flex; justify-content: space-between; font-size: 12px; color: #8b93a7; margin-bottom: 6px; }
  .bar { height: 10px; border-radius: 999px; background: #1d2333; overflow: hidden; }
  .bar > div { height: 100%; width: 0%; background: linear-gradient(90deg, #7c5cff, #39d98a); transition: width .3s; }
  .list { border: 1px solid #232838; border-radius: 12px; padding: 10px 12px; background: #121623; min-height: 0; }
  .list h3 { margin: 0 0 6px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b93a7; font-weight: 600; }
  ol, ul { margin: 0; padding-left: 18px; font-size: 13px; }
  #log { padding-left: 0; list-style: none; max-height: 190px; overflow: auto; }
  #log li { padding: 3px 0; border-bottom: 1px solid #1b2030; color: #c3c9d8; }
  #log time { color: #6f778b; margin-right: 6px; font-variant-numeric: tabular-nums; }
  #log .say { color: #fff; }
  #log .act { color: #a99cff; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <strong>TikTok Live Game</strong>
  <span id="conn">conectando…</span>
  <span class="hint" id="thr"></span>
</header>

<main>
  <section class="stage">
    <div class="bubble" id="bubble"></div>
    <div class="character" id="character">🙂</div>
    <div class="anim" id="anim">aguardando eventos</div>
  </section>

  <section class="panel">
    <div class="cards">
      <div class="card"><h3>Moedas</h3><div class="big" id="coins">0</div><small id="gifts">0 presentes</small></div>
      <div class="card"><h3>Curtidas</h3><div class="big" id="likes">0</div><small id="likesNext">próximo marco: 100</small></div>
      <div class="card"><h3>Chat respondido</h3><div class="big" id="replies">0 / 0</div><small id="rate">0%</small></div>
      <div class="card"><h3>Espectadores</h3><div class="big" id="viewers">0</div><small id="status">—</small></div>
    </div>

    <div class="goal">
      <div class="goal-head"><span>Meta de moedas</span><span id="goalLabel">0 / 0</span></div>
      <div class="bar"><div id="goalBar"></div></div>
    </div>

    <div class="list">
      <h3>Top doadores</h3>
      <ol id="board"><li>—</li></ol>
    </div>

    <div class="list">
      <h3>Eventos</h3>
      <ul id="log"></ul>
    </div>
  </section>
</main>

<script>
  const $ = (id) => document.getElementById(id);
  const EMOJI = {
    wave: '👋', cheer: '🙌', dance: '💃', celebrate: '🎉', bow: '🙇',
    hype: '🔥', fireworks: '🎆', idle: '🙂', default: '✨'
  };

  let state = null;
  let cfg = null;
  let bubbleTimer = null;
  let animTimer = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(proto + '://' + location.host + '/ws');

    socket.onopen = () => setConnection('conectado', true);
    socket.onclose = () => {
      setConnection('reconectando…', false);
      setTimeout(connect, 2000);
    };
    socket.onerror = () => setConnection('erro de conexão', false);
    socket.onmessage = (event) => {
      try { handle(JSON.parse(event.data)); } catch (error) { console.error(error); }
    };
  }

  function setConnection(text, online) {
    $('conn').textContent = text;
    $('dot').classList.toggle('on', online);
  }

  function handle(message) {
    if (message.type === 'hello') {
      cfg = message.config;
      state = message.state;
      $('thr').textContent =
        'presente caro: > ' + cfg.thresholds.expensiveGiftCoins + ' moedas · marco: ' +
        cfg.thresholds.likeStep + ' curtidas';
      render();
      return;
    }
    if (message.type === 'state') {
      state = message.state;
      render();
      return;
    }
    if (message.type === 'action') onAction(message.action);
  }

  function onAction(action) {
    if (action.kind === 'character.act') {
      playAct(action);
      addLog('act', action.reason + ' → ' + action.animation + ' (força ' + action.intensity + ')');
    } else if (action.kind === 'character.say') {
      speak(action.text);
      addLog('say', action.reason + ': ' + action.text);
    }
  }

  function playAct(action) {
    const character = $('character');
    character.textContent = EMOJI[action.animation] || EMOJI.default;
    character.style.fontSize = (58 + action.intensity * 12) + 'px';
    character.classList.add('bump');
    clearTimeout(animTimer);
    animTimer = setTimeout(() => character.classList.remove('bump'), 280);

    $('anim').textContent = action.animation + ' · ' + action.reason +
      (action.user ? ' · ' + action.user.nickname : '');
  }

  function speak(text) {
    const bubble = $('bubble');
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 7000);
  }

  function render() {
    if (!state) return;
    const chat = state.chat;

    $('coins').textContent = state.totals.coins.toLocaleString('pt-BR');
    $('gifts').textContent = state.totals.gifts + ' presentes';
    $('likes').textContent = state.like.total.toLocaleString('pt-BR');
    $('likesNext').textContent = 'próximo marco: ' + state.like.nextMilestone;
    $('replies').textContent = chat.repliesInWindow + ' / ' + chat.messagesInWindow;
    $('rate').textContent = Math.round(chat.replyRate * 100) + '% da janela de ' + chat.windowSize;
    $('viewers').textContent = state.connection.viewers.toLocaleString('pt-BR');
    $('status').textContent = state.connection.status + (state.connection.message ? ' · ' + state.connection.message : '');

    const target = state.goal.targetCoins || 1;
    const pct = Math.min(100, Math.round((state.totals.coins / target) * 100));
    $('goalBar').style.width = pct + '%';
    $('goalLabel').textContent =
      state.totals.coins.toLocaleString('pt-BR') + ' / ' + target.toLocaleString('pt-BR');

    const board = $('board');
    board.textContent = '';
    if (state.leaderboard.length === 0) {
      const li = document.createElement('li');
      li.textContent = '—';
      board.appendChild(li);
    }
    for (const entry of state.leaderboard) {
      const li = document.createElement('li');
      li.textContent = entry.user.nickname + ' — ' + entry.coins.toLocaleString('pt-BR') + ' moedas';
      board.appendChild(li);
    }
  }

  function addLog(kind, text) {
    const log = $('log');
    const li = document.createElement('li');
    li.className = kind;
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('pt-BR');
    li.appendChild(time);
    li.appendChild(document.createTextNode(text));
    log.prepend(li);
    while (log.children.length > 60) log.removeChild(log.lastChild);
  }

  connect();
</script>
</body>
</html>`;
}
