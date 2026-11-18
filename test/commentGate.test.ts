import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeClock } from '../src/clock.js';
import { CommentGate } from '../src/engine/commentGate.js';

const BASE = {
  enabled: true,
  chance: 1,
  cooldownMs: 0,
  perUserCooldownMs: 0,
  maxPerMinute: 60,
};

describe('CommentGate', () => {
  it('respeita o cooldown global', async () => {
    const clock = new FakeClock();
    const gate = new CommentGate({ ...BASE, cooldownMs: 5000 }, clock, () => 0);

    assert.equal(gate.take('a'), true);
    assert.equal(gate.take('b'), false);

    await clock.advance(4999);
    assert.equal(gate.take('b'), false);

    await clock.advance(1);
    assert.equal(gate.take('b'), true);
  });

  it('respeita o cooldown por pessoa', async () => {
    const clock = new FakeClock();
    const gate = new CommentGate({ ...BASE, perUserCooldownMs: 10_000 }, clock, () => 0);

    assert.equal(gate.take('a'), true);
    assert.equal(gate.take('b'), true);
    assert.equal(gate.take('a'), false);

    await clock.advance(10_000);
    assert.equal(gate.take('a'), true);
  });

  it('nunca fala com chance zero', () => {
    const clock = new FakeClock();
    const gate = new CommentGate({ ...BASE, chance: 0 }, clock, () => 0);
    assert.equal(gate.take('a'), false);
  });

  it('limita por minuto e libera depois de um minuto', async () => {
    const clock = new FakeClock();
    const gate = new CommentGate({ ...BASE, maxPerMinute: 2 }, clock, () => 0);

    assert.equal(gate.take('a'), true);
    assert.equal(gate.take('b'), true);
    assert.equal(gate.take('c'), false);

    await clock.advance(60_001);
    assert.equal(gate.take('c'), true);
  });

  it('não faz nada quando desligado', () => {
    const clock = new FakeClock();
    const gate = new CommentGate({ ...BASE, enabled: false }, clock, () => 0);
    assert.equal(gate.take('a'), false);
  });
});
