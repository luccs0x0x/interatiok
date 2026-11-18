import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameConfigSchema } from '../src/config.js';

describe('GameConfig — comentários de humor', () => {
  it('aplica os padrões de fala para entrada, curtida e doação', () => {
    const config = GameConfigSchema.parse({});

    assert.equal(config.social.joinComment.enabled, true);
    assert.equal(config.social.joinComment.cooldownMs, 10_000);
    assert.equal(config.likes.comment.enabled, true);
    assert.equal(config.likes.comment.maxPerMinute, 6);
    assert.equal(config.donation.low.maxCoins, 50);
    assert.equal(config.donation.high.minCoins, 500);
  });

  it('rejeita faixas de doação invertidas', () => {
    assert.throws(
      () =>
        GameConfigSchema.parse({
          donation: { low: { maxCoins: 600 }, high: { minCoins: 500 } },
        }),
      /low\.maxCoins precisa ser menor/,
    );
  });
});
