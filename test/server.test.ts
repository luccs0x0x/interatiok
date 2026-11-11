import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { FakeClock } from '../src/clock.js';
import { GameEngine } from '../src/engine/gameEngine.js';
import { CharacterResponder } from '../src/engine/responder.js';
import { GameServer } from '../src/server/server.js';
import { createLogger } from '../src/logger.js';
import {
  testConfig,
  testLines,
  testLogger
} from './helpers.js';

interface Harness {
  server: GameServer;
  engine: GameEngine;
  httpUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

async function startServer(options: { simToken?: string } = {}): Promise<Harness> {
  const config = testConfig({
    overlay: { host: '127.0.0.1', port: 0, stateThrottleMs: 0 },
  });
  const lines = testLines();
  const clock = new FakeClock();
  const responder = new CharacterResponder(lines, { rng: () => 0 });

  let server!: GameServer;
  const engine = new GameEngine({
    config,
    lines,
    clock,
    responder,
    logger: testLogger,
    onAction: (action) => server.broadcastAction(action),
    onState: (state) => server.broadcastState(state),
  });

  server = new GameServer({
    engine,
    config,
    logger: createLogger('silent'),
    ...(options.simToken ? { simToken: options.simToken } : {}),
  });

  const address = await server.listen();
  return {
    server,
    engine,
    httpUrl: address.httpUrl,
    wsUrl: address.wsUrl,
    close: () => server.close(),
  };
}

async function waitFor<T>(finder: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = finder();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('timeout esperando mensagem');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface ClientHarness {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  close(): void;
}

async function connect(wsUrl: string): Promise<ClientHarness> {
  const socket = new WebSocket(wsUrl);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (raw: WebSocket.RawData) => {
    messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  socket.on('error', () => undefined);
  await once(socket, 'open');
  return { socket, messages, close: () => socket.close() };
}

describe('GameServer', () => {
  it('entrega hello com estado e configuração pública', async () => {
    const harness = await startServer();
    const client = await connect(harness.wsUrl);
    try {
      const hello = await waitFor(() =>
        client.messages.find((message) => message.type === 'hello'),
      );
      assert.equal(hello?.v, 1);
      const state = hello?.state as { protocol: number };
      assert.equal(state.protocol, 1);

      const config = hello?.config as {
        thresholds: { expensiveGiftCoins: number; likeStep: number };
        chat: { minRepliesPerWindow: number; windowSize: number };
      };
      assert.equal(config.thresholds.expensiveGiftCoins, 1000);
      assert.equal(config.thresholds.likeStep, 100);
      assert.equal(config.chat.minRepliesPerWindow, 4);
      assert.equal(config.chat.windowSize, 10);
    } finally {
      client.close();
      await harness.close();
    }
  });

  it('aceita eventos simulados e transmite as ações', async () => {
    const harness = await startServer();
    const client = await connect(harness.wsUrl);
    try {
      await waitFor(() => client.messages.find((message) => message.type === 'hello'));

      const response = await fetch(`${harness.httpUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            { type: 'like', count: 100, user: { id: '1', nickname: 'Bia' } },
            {
              type: 'gift',
              user: { id: '2', nickname: 'Nanda' },
              giftName: 'Leão',
              diamonds: 600,
              repeatCount: 1,
            },
            { type: 'chat', user: { id: '3', nickname: 'Juca' }, text: 'oi Lia' },
          ],
        }),
      });

      assert.equal(response.status, 200);
      const payload = (await response.json()) as { accepted: number };
      assert.equal(payload.accepted, 3);

      const likeAction = await waitFor(() =>
        client.messages.find(
          (message) =>
            message.type === 'action' &&
            (message.action as { reason: string }).reason === 'like_milestone',
        ),
      );
      assert.ok(likeAction);

      await waitFor(() =>
        client.messages.find(
          (message) =>
            message.type === 'action' &&
            (message.action as { reason: string }).reason === 'expensive_gift',
        ),
      );

      const bubble = await waitFor(() =>
        client.messages.find(
          (message) =>
            message.type === 'action' &&
            (message.action as { kind: string }).kind === 'character.say',
        ),
      );
      const sayText = (bubble.action as { text: string }).text;
      assert.ok(sayText.length > 0);

      const state = (await (await fetch(`${harness.httpUrl}/state`)).json()) as {
        totals: { coins: number; likes: number };
      };
      assert.equal(state.totals.coins, 1200);
      assert.equal(state.totals.likes, 100);

      const health = (await (await fetch(`${harness.httpUrl}/health`)).json()) as {
        ok: boolean;
      };
      assert.equal(health.ok, true);

      const page = await fetch(`${harness.httpUrl}/`);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    } finally {
      client.close();
      await harness.close();
    }
  });

  it('protege /api/simulate quando SIM_TOKEN está configurado', async () => {
    const harness = await startServer({ simToken: 'segredo' });
    try {
      const denied = await fetch(`${harness.httpUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'like', count: 100 }] }),
      });
      assert.equal(denied.status, 403);

      const allowed = await fetch(`${harness.httpUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sim-token': 'segredo' },
        body: JSON.stringify({ events: [{ type: 'like', count: 100 }] }),
      });
      assert.equal(allowed.status, 200);
      assert.equal(harness.engine.getState().totals.likes, 100);
    } finally {
      await harness.close();
    }
  });

  it('recusa eventos inválidos', async () => {
    const harness = await startServer();
    try {
      const response = await fetch(`${harness.httpUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'desconhecido' }] }),
      });
      assert.equal(response.status, 422);
    } finally {
      await harness.close();
    }
  });

  it('responde ping com pong', async () => {
    const harness = await startServer();
    const client = await connect(harness.wsUrl);
    try {
      await waitFor(() => client.messages.find((message) => message.type === 'hello'));
      client.socket.send(JSON.stringify({ type: 'ping', t: 123 }));
      const pong = await waitFor(() =>
        client.messages.find((message) => message.type === 'pong'),
      );
      assert.ok(pong);
    } finally {
      client.close();
      await harness.close();
    }
  });
});

describe('normalizeSimulatedEvent', () => {
  it('normaliza like com usuário padrão', async () => {
    const { normalizeSimulatedEvents } = await import('../src/server/simulateInput.js');
    const [event] = normalizeSimulatedEvents([{ type: 'like', count: '150' }]);
    assert.equal(event?.type, 'like');
    assert.equal(event?.type === 'like' ? event.count : -1, 150);
    assert.equal(event?.type === 'like' ? event.user.nickname : '', 'Sim');
  });

  it('descarta chat vazio e tipo desconhecido', async () => {
    const { normalizeSimulatedEvents } = await import('../src/server/simulateInput.js');
    assert.equal(normalizeSimulatedEvents([{ type: 'chat', text: '   ' }]).length, 0);
    assert.equal(normalizeSimulatedEvents([{ type: 'nope' }]).length, 0);
    assert.equal(normalizeSimulatedEvents('nada').length, 0);
  });

  it('usa o presente com diamantes e combo', async () => {
    const { normalizeSimulatedEvents } = await import('../src/server/simulateInput.js');
    const [event] = normalizeSimulatedEvents([
      {
        type: 'gift',
        user: { userId: '2', nickname: 'Nanda' },
        giftName: 'Leão',
        diamonds: 600,
        repeatCount: 2,
        streakable: true,
        comboEnd: true,
      },
    ]);
    assert.equal(event?.type, 'gift');
    if (event?.type === 'gift') {
      assert.equal(event.diamonds, 600);
      assert.equal(event.repeatCount, 2);
      assert.equal(event.user.nickname, 'Nanda');
    }
  });
});
