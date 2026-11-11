import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeClock } from '../src/clock.js';
import { GiftCombiner, type CombinedGift } from '../src/engine/giftCombiner.js';
import type { GiftEvent } from '../src/types.js';
import { viewer } from './helpers.js';

function gift(overrides: Partial<GiftEvent> = {}): GiftEvent {
  return {
    type: 'gift',
    id: 'g1',
    ts: 0,
    user: viewer('1', 'Bia'),
    giftId: '5655',
    giftName: 'Rosa',
    diamonds: 1,
    repeatCount: 1,
    comboEnd: false,
    streakable: true,
    ...overrides,
  };
}

function createCombiner() {
  const clock = new FakeClock();
  const flushes: CombinedGift[] = [];
  const combiner = new GiftCombiner(clock, 1500, (combined) => flushes.push(combined));
  return { combiner, clock, flushes };
}

describe('GiftCombiner', () => {
  it('presente sem combo emite imediatamente', () => {
    const { combiner, flushes } = createCombiner();
    combiner.push(gift({ streakable: false, comboEnd: false, diamonds: 5 }));

    assert.equal(flushes.length, 1);
    assert.equal(flushes[0]?.repeatCount, 1);
    assert.equal(flushes[0]?.diamonds, 5);
  });

  it('agrega o combo e só emite no repeatEnd', () => {
    const { combiner, flushes } = createCombiner();

    combiner.push(gift({ repeatCount: 1, comboEnd: false }));
    combiner.push(gift({ repeatCount: 2, comboEnd: false }));
    assert.equal(flushes.length, 0);

    combiner.push(gift({ repeatCount: 3, comboEnd: true }));
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0]?.repeatCount, 3);
  });

  it('emite sozinho quando o combo para de chegar', async () => {
    const { combiner, clock, flushes } = createCombiner();

    combiner.push(gift({ repeatCount: 1 }));
    combiner.push(gift({ repeatCount: 2 }));

    await clock.advance(1499);
    assert.equal(flushes.length, 0);

    await clock.advance(1);
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0]?.repeatCount, 2);
  });

  it('não mistura combos de pessoas diferentes', () => {
    const { combiner, flushes } = createCombiner();

    combiner.push(gift({ user: viewer('1', 'Bia'), repeatCount: 1 }));
    combiner.push(gift({ user: viewer('2', 'Lucas'), repeatCount: 1 }));
    combiner.push(gift({ user: viewer('1', 'Bia'), repeatCount: 2, comboEnd: true }));
    combiner.push(gift({ user: viewer('2', 'Lucas'), repeatCount: 2, comboEnd: true }));

    assert.equal(flushes.length, 2);
    assert.deepEqual(
      flushes.map((flush) => flush.user.nickname),
      ['Bia', 'Lucas'],
    );
  });

  it('flushAll encerra combos abertos', () => {
    const { combiner, flushes } = createCombiner();

    combiner.push(gift({ repeatCount: 2 }));
    combiner.flushAll();

    assert.equal(flushes.length, 1);
    assert.equal(flushes[0]?.repeatCount, 2);
  });
});
