import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FakeClock } from '../src/clock.js';
import type { PersistedSession } from '../src/engine/gameEngine.js';
import { createLogger } from '../src/logger.js';
import { SessionStore } from '../src/state/sessionStore.js';

const logger = createLogger('silent');

function snapshot(coins: number): PersistedSession {
  return {
    version: 1,
    savedAt: 0,
    totals: {
      coins,
      gifts: 1,
      likes: 0,
      messages: 0,
      replies: 0,
      followers: 0,
      shares: 0,
      subscribers: 0,
    },
    leaderboard: [],
    like: { total: 0, milestone: 0, buffer: 0 },
    goalReached: false,
  };
}

describe('SessionStore', () => {
  it('grava com debounce e relê a sessão', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tiktok-game-'));
    const path = join(dir, 'session.json');
    const clock = new FakeClock();
    const store = new SessionStore(path, clock, 1000, logger);

    store.scheduleSave(() => snapshot(500));
    await clock.advance(999);
    assert.equal(existsSync(path), false, 'ainda não gravou');

    await clock.advance(1);
    assert.equal(existsSync(path), true);

    const loaded = new SessionStore(path, clock, 1000, logger).load();
    assert.equal(loaded?.totals.coins, 500);
    assert.equal(loaded?.version, 1);
  });

  it('flush grava na hora e várias chamadas viram uma gravação', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tiktok-game-'));
    const path = join(dir, 'session.json');
    const clock = new FakeClock();
    const store = new SessionStore(path, clock, 5000, logger);

    store.scheduleSave(() => snapshot(100));
    store.scheduleSave(() => snapshot(200));
    store.flush();

    const loaded = new SessionStore(path, clock, 5000, logger).load();
    assert.equal(loaded?.totals.coins, 200, 'vale o último snapshot');
  });

  it('ignora arquivo corrompido', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tiktok-game-'));
    const path = join(dir, 'session.json');
    writeFileSync(path, '{ não é json', 'utf8');

    const store = new SessionStore(path, new FakeClock(), 1000, logger);
    assert.equal(store.load(), null);
  });
});
