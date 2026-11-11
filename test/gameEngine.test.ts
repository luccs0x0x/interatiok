import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeClock, flushMicrotasks } from '../src/clock.js';
import { GameEngine } from '../src/engine/gameEngine.js';
import { CharacterResponder } from '../src/engine/responder.js';
import type { GiftEvent, LikeEvent } from '../src/types.js';
import {
  acts,
  chatEvent,
  createEngine,
  says,
  testLogger,
  viewer,
  type EngineHarness,
} from './helpers.js';

function gift(overrides: Partial<GiftEvent> = {}): GiftEvent {
  return {
    type: 'gift',
    id: `gift-${Math.random().toString(36).slice(2)}`,
    ts: 1_700_000_000_000,
    user: viewer('1', 'Bia'),
    giftId: '5655',
    giftName: 'Rosa',
    diamonds: 10,
    repeatCount: 1,
    comboEnd: true,
    streakable: false,
    ...overrides,
  };
}

function like(count: number, user = viewer('1', 'Bia')): LikeEvent {
  return { type: 'like', id: `like-${count}`, ts: 1_700_000_000_000, user, count };
}

function lastAct(harness: EngineHarness) {
  const list = acts(harness.actions);
  return list[list.length - 1];
}

describe('GameEngine — doações', () => {
  it('presente barato vira ação de doação e soma moedas', () => {
    const harness = createEngine();
    harness.engine.ingest(gift({ diamonds: 10 }));

    const act = lastAct(harness);
    assert.equal(act?.kind, 'character.act');
    assert.equal(act?.reason, 'donation');
    assert.equal(act?.animation, 'wave');
    assert.equal(act?.intensity, 1);
    assert.equal(act?.data.coins, 20, '10 diamantes × 2 moedas');
    assert.equal(act?.data.tier, 'bronze');
    assert.equal(harness.engine.getState().totals.coins, 20);
    assert.equal(says(harness.actions).length, 0, 'presente barato não fala');
  });

  it('presente acima de 1000 moedas faz o personagem responder a pessoa', async () => {
    const harness = createEngine();
    harness.engine.ingest(gift({ diamonds: 600, user: viewer('9', 'Nanda'), giftName: 'Leão' }));

    const act = lastAct(harness);
    assert.equal(act?.reason, 'expensive_gift');
    assert.equal(act?.animation, 'bow');
    assert.equal(act?.intensity, 5);
    assert.equal(act?.data.coins, 1200);

    await flushMicrotasks();
    const spoken = says(harness.actions);
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0]?.kind, 'character.say');
    assert.match(spoken[0]?.text ?? '', /Nanda/);
    assert.match(spoken[0]?.text ?? '', /Leão/);
    assert.equal(spoken[0]?.emotion, 'surprised');
  });

  it('exatamente 1000 moedas ainda não é presente caro (limite é "acima de")', () => {
    const harness = createEngine();
    harness.engine.ingest(gift({ diamonds: 500 }));

    const act = lastAct(harness);
    assert.equal(act?.reason, 'donation');
    assert.equal(act?.data.tier, 'diamante');
    assert.equal(act?.animation, 'celebrate');
  });

  it('junta o combo antes de calcular o valor e a faixa', async () => {
    const harness = createEngine();

    harness.engine.ingest(
      gift({ id: 'c1', diamonds: 200, repeatCount: 1, comboEnd: false, streakable: true }),
    );
    assert.equal(harness.actions.length, 0, 'nada antes do fim do combo');

    harness.engine.ingest(
      gift({ id: 'c2', diamonds: 200, repeatCount: 3, comboEnd: true, streakable: true }),
    );

    const act = lastAct(harness);
    assert.equal(acts(harness.actions).length, 1, 'uma ação por combo');
    assert.equal(act?.data.repeat, 3);
    assert.equal(act?.data.coins, 1200, '200 diamantes × 3 × 2 moedas');
    assert.equal(act?.reason, 'expensive_gift');

    await flushMicrotasks();
    assert.equal(says(harness.actions).length, 1);
  });

  it('permite sobrescrever o valor de um presente específico', () => {
    const harness = createEngine({ coins: { overrides: { '5655': 1500 } } });
    harness.engine.ingest(gift({ giftId: '5655', diamonds: 1 }));

    const act = lastAct(harness);
    assert.equal(act?.data.coins, 1500);
    assert.equal(act?.reason, 'expensive_gift');
  });

  it('bate a meta uma única vez', async () => {
    const harness = createEngine({ donation: { goal: { targetCoins: 100, announce: true } } });

    harness.engine.ingest(gift({ diamonds: 30 })); // 60 moedas
    assert.equal(harness.engine.getState().goal.reached, false);

    harness.engine.ingest(gift({ diamonds: 30 })); // 120 moedas
    await flushMicrotasks();

    const goalActs = acts(harness.actions).filter((act) => act.reason === 'goal');
    assert.equal(goalActs.length, 1);
    assert.equal(goalActs[0]?.animation, 'fireworks');
    assert.equal(harness.engine.getState().goal.reached, true);

    harness.engine.ingest(gift({ diamonds: 30 }));
    await flushMicrotasks();
    assert.equal(
      acts(harness.actions).filter((act) => act.reason === 'goal').length,
      1,
      'meta não repete',
    );
  });

  it('monta o ranking dos maiores doadores', () => {
    const harness = createEngine();

    harness.engine.ingest(gift({ user: viewer('a', 'Ana'), diamonds: 600 })); // 1200
    harness.engine.ingest(gift({ user: viewer('b', 'Bruno'), diamonds: 900 })); // 1800
    harness.engine.ingest(gift({ user: viewer('c', 'Caio'), diamonds: 10 })); // 20
    harness.engine.ingest(gift({ user: viewer('a', 'Ana'), diamonds: 100 })); // +200

    const board = harness.engine.getState().leaderboard;
    assert.deepEqual(
      board.map((entry) => entry.user.nickname),
      ['Bruno', 'Ana', 'Caio'],
    );
    assert.equal(board[0]?.coins, 1800);
    assert.equal(board[1]?.coins, 1400);
  });
});

describe('GameEngine — curtidas', () => {
  it('dispara ação a cada 100 curtidas acumuladas', () => {
    const harness = createEngine();

    harness.engine.ingest(like(60));
    assert.equal(acts(harness.actions).length, 0);

    harness.engine.ingest(like(50));
    assert.equal(acts(harness.actions).length, 1);
    assert.equal(acts(harness.actions)[0]?.reason, 'like_milestone');
    assert.equal(acts(harness.actions)[0]?.data.milestone, 1);
    assert.equal(acts(harness.actions)[0]?.data.totalLikes, 110);
    assert.equal(harness.engine.getState().like.total, 110);
    assert.equal(harness.engine.getState().like.milestone, 1);
    assert.equal(harness.engine.getState().like.nextMilestone, 200);
  });

  it('limita animações de um lote gigante, mas conta todos os marcos', () => {
    const harness = createEngine({ likes: { maxMilestonesPerEvent: 3 } });

    harness.engine.ingest(like(1000));

    assert.equal(acts(harness.actions).length, 3, 'no máximo 3 animações por mensagem');
    const state = harness.engine.getState();
    assert.equal(state.like.milestone, 10);
    assert.equal(state.like.total, 1000);
    assert.equal(state.like.nextMilestone, 1100);
  });

  it('acumula o resto entre marcos', () => {
    const harness = createEngine();
    harness.engine.ingest(like(30));
    harness.engine.ingest(like(30));
    harness.engine.ingest(like(60));

    assert.equal(harness.engine.getState().like.milestone, 1);
    assert.equal(harness.engine.getState().like.progress, 0.2);
  });
});

describe('GameEngine — chat', () => {
  it('responde 4 de 10 mensagens em ~2,4s (piso entre falas)', async () => {
    const harness = createEngine();

    for (let i = 0; i < 10; i++) {
      harness.engine.ingest(chatEvent(`m${i}`, `mensagem ${i}`, viewer(String(i), `User${i}`)));
    }

    await flushMicrotasks();
    assert.equal(says(harness.actions).length, 1, 'a primeira resposta sai na hora');

    await harness.clock.advance(2400);
    const state = harness.engine.getState();
    assert.equal(says(harness.actions).length, 4);
    assert.equal(state.chat.repliesInWindow, 4);
    assert.equal(state.chat.messagesInWindow, 10);
    assert.equal(state.chat.target, 4);
    assert.equal(state.totals.messages, 10);
    assert.equal(state.totals.replies, 4);

    const say = says(harness.actions)[0];
    assert.equal(say?.reason, 'chat');
    assert.ok(say?.user);
    assert.ok(typeof say?.data.chatMessageId === 'string');
  });

  it('completa até 6 respostas conforme o cooldown passa', async () => {
    const harness = createEngine();

    for (let i = 0; i < 10; i++) {
      harness.engine.ingest(chatEvent(`m${i}`, `mensagem ${i}`, viewer(String(i), `User${i}`)));
    }
    await flushMicrotasks();
    assert.equal(says(harness.actions).length, 1);

    await harness.clock.advance(2400);
    assert.equal(says(harness.actions).length, 4);

    await harness.clock.advance(6000);
    assert.equal(says(harness.actions).length, 6);
    assert.equal(harness.engine.getState().chat.repliesInWindow, 6);

    await harness.clock.advance(6000);
    assert.equal(says(harness.actions).length, 6, 'teto de 6 por janela');
  });
});

describe('GameEngine — social', () => {
  it('reage a follow, share e assinatura', () => {
    const harness = createEngine();
    const user = viewer('5', 'Juh');

    harness.engine.ingest({ type: 'follow', id: 'f1', ts: 1, user });
    harness.engine.ingest({ type: 'share', id: 's1', ts: 2, user });
    harness.engine.ingest({ type: 'subscribe', id: 'sub1', ts: 3, user });

    const state = harness.engine.getState();
    assert.equal(state.totals.followers, 1);
    assert.equal(state.totals.shares, 1);
    assert.equal(state.totals.subscribers, 1);

    const reasons = acts(harness.actions).map((act) => act.reason);
    assert.deepEqual(reasons, ['follow', 'share', 'subscribe']);
    assert.equal(says(harness.actions).length, 1, 'só assinatura ganha fala');
  });

  it('atualiza espectadores', () => {
    const harness = createEngine();
    harness.engine.ingest({ type: 'viewers', id: 'v1', ts: 1, count: 321 });
    assert.equal(harness.engine.getState().connection.viewers, 321);
  });
});

describe('GameEngine — sessão', () => {
  it('restaura totais, ranking e meta a partir do snapshot', () => {
    const first = createEngine({ donation: { goal: { targetCoins: 100 } } });
    first.engine.ingest(gift({ diamonds: 600, user: viewer('7', 'Nanda') }));
    first.engine.ingest(gift({ diamonds: 10 }));

    const snapshot = first.engine.snapshot();
    assert.equal(snapshot.totals.coins, 1220);
    assert.equal(snapshot.goalReached, true);

    const restored = new GameEngine({
      config: first.config,
      lines: first.lines,
      clock: new FakeClock(),
      responder: new CharacterResponder(first.lines, { rng: () => 0 }),
      logger: testLogger,
      onAction: () => undefined,
      session: snapshot,
    });

    const state = restored.getState();
    assert.equal(state.totals.coins, 1220);
    assert.equal(state.goal.reached, true);
    assert.equal(state.leaderboard[0]?.user.nickname, 'Nanda');
  });
});
