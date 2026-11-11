import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeClock } from '../src/clock.js';
import {
  ChatScheduler,
  type ChatRecord,
  type ChatSchedulerOptions,
} from '../src/engine/chatScheduler.js';
import { viewer } from './helpers.js';

function createScheduler(overrides: Partial<ChatSchedulerOptions> = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const replied: ChatRecord[] = [];
  const repliedAt: number[] = [];
  const options: ChatSchedulerOptions = {
    windowSize: 10,
    minRepliesPerWindow: 4,
    maxRepliesPerWindow: 6,
    cooldownMs: 2500,
    minReplyGapMs: 800,
    perUserCooldownMs: 20_000,
    sameUserFloorMs: 1200,
    duplicateWindowMs: 30_000,
    maxQueue: 30,
    minLength: 2,
    ignoreCommands: true,
    ...overrides,
  };
  const scheduler = new ChatScheduler(options, clock, (record) => {
    replied.push(record);
    repliedAt.push(clock.now());
  });
  return { scheduler, clock, replied, repliedAt };
}

describe('ChatScheduler — garantia de 4 respostas em 10', () => {
  it('responde 4 das 10 primeiras mensagens e para no teto de 6', async () => {
    const { scheduler, clock, replied } = createScheduler();

    for (let i = 0; i < 10; i++) {
      scheduler.offer({ id: `m${i}`, user: viewer(String(i)), text: `mensagem número ${i}` });
    }

    assert.equal(
      replied.length,
      1,
      'a primeira responde na hora; as outras respeitam o piso de 800ms',
    );
    assert.equal(scheduler.metrics().messagesInWindow, 10);
    assert.equal(scheduler.metrics().target, 4);

    await clock.advance(2400);
    assert.equal(replied.length, 4, 'a cota de 4/10 é cumprida em ~2,4s');
    assert.equal(scheduler.metrics().repliesInWindow, 4);

    await clock.advance(6000);
    assert.equal(replied.length, 6, 'cooldown libera mais 2 respostas até o teto');
    assert.equal(scheduler.metrics().repliesInWindow, 6);

    await clock.advance(10_000);
    assert.equal(replied.length, 6, 'não passa do teto de 6 por janela');
  });

  it('recupera a cota quando a janela desliza', async () => {
    const { scheduler, clock, replied } = createScheduler();

    for (let i = 0; i < 10; i++) {
      scheduler.offer({ id: `a${i}`, user: viewer(String(i)), text: `primeira leva ${i}` });
    }
    await clock.advance(6000);
    assert.ok(replied.length >= 4);

    for (let i = 0; i < 6; i++) {
      scheduler.offer({ id: `b${i}`, user: viewer(`b${i}`), text: `segunda leva ${i}` });
    }
    await clock.advance(5000);

    const metrics = scheduler.metrics();
    assert.ok(
      metrics.repliesInWindow >= 4,
      `janela deveria ter ao menos 4 respostas, tem ${metrics.repliesInWindow}`,
    );
    assert.ok(metrics.repliesInWindow <= 6);
  });

  it('respeita o piso entre respostas para a mesma pessoa', async () => {
    const { scheduler, clock, replied, repliedAt } = createScheduler();
    const mesma = viewer('42', 'Spam');

    for (let i = 0; i < 4; i++) {
      scheduler.offer({ id: `s${i}`, user: mesma, text: `texto diferente ${i}` });
    }

    await clock.advance(4000);

    assert.equal(replied.length, 4, 'a cota força responder as 4, mesmo da mesma pessoa');

    for (let i = 1; i < repliedAt.length; i++) {
      const gap = (repliedAt[i] ?? 0) - (repliedAt[i - 1] ?? 0);
      assert.ok(gap >= 1200, `intervalo entre respostas muito curto: ${gap}ms`);
    }
  });

  it('espaça respostas de uma rajada com o cooldown global', async () => {
    const { scheduler, clock } = createScheduler({
      minRepliesPerWindow: 0,
      maxRepliesPerWindow: 6,
    });

    for (let i = 0; i < 10; i++) {
      scheduler.offer({ id: `r${i}`, user: viewer(String(i)), text: `rajada ${i}` });
    }

    assert.equal(scheduler.metrics().repliesInWindow, 1, 'a primeira resposta é imediata');

    await clock.advance(2500);
    assert.equal(scheduler.metrics().repliesInWindow, 2);
    await clock.advance(2500);
    assert.equal(scheduler.metrics().repliesInWindow, 3);
    await clock.advance(7500);
    assert.equal(scheduler.metrics().repliesInWindow, 6);
    await clock.advance(10_000);
    assert.equal(scheduler.metrics().repliesInWindow, 6);
  });

  it('ignora mensagens curtas, comandos e duplicatas', async () => {
    const { scheduler, clock, replied } = createScheduler();
    const user = viewer('7', 'Duda');

    assert.deepEqual(scheduler.offer({ id: 'x', user, text: 'a' }), {
      accepted: false,
      reason: 'short',
    });
    assert.deepEqual(scheduler.offer({ id: 'y', user, text: '!comando' }), {
      accepted: false,
      reason: 'command',
    });

    assert.equal(scheduler.offer({ id: 'z1', user, text: 'oi Lia' }).accepted, true);
    await clock.advance(1000);
    assert.deepEqual(scheduler.offer({ id: 'z2', user, text: 'oi Lia' }), {
      accepted: false,
      reason: 'duplicate',
    });

    await clock.advance(40_000);
    assert.equal(scheduler.offer({ id: 'z3', user, text: 'oi Lia' }).accepted, true);
    assert.equal(replied.length, 2);
    assert.equal(scheduler.metrics().totalDropped, 3);
  });

  it('descarta a mais antiga quando a fila enche', () => {
    const { scheduler } = createScheduler({ minRepliesPerWindow: 0, maxQueue: 2 });
    const user = viewer('9', 'Gui');

    // Primeira mensagem é respondida na hora; depois o cooldown segura as outras.
    scheduler.offer({ id: 'warm', user, text: 'primeira mensagem' });
    assert.equal(scheduler.metrics().totalReplies, 1);

    for (let i = 0; i < 5; i++) {
      scheduler.offer({ id: `q${i}`, user: viewer(String(i)), text: `fila ${i}` });
    }

    const metrics = scheduler.metrics();
    assert.equal(metrics.totalDropped, 3);
    assert.equal(metrics.messagesInWindow, 3, 'descarts saem da janela de contagem');
    assert.equal(metrics.totalReplies, 1);
  });

  it('nunca passa do teto em chat contínuo', async () => {
    const { scheduler, clock } = createScheduler();

    for (let i = 0; i < 20; i++) {
      scheduler.offer({ id: `c${i}`, user: viewer(String(i % 8)), text: `contínuo ${i}` });
      await clock.advance(3000);
      assert.ok(
        scheduler.metrics().repliesInWindow <= 6,
        `teto estourado no passo ${i}: ${scheduler.metrics().repliesInWindow}`,
      );
    }
  });
});
