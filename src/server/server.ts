/**
 * Servidor do jogo: serve o overlay de debug, expõe estado via HTTP e empurra
 * ações/estado em tempo real por WebSocket.
 *
 * O visual feito em outra ferramenta (OBS/browser source, Unity, etc.) só
 * precisa consumir `ws://host:porta/ws` — o contrato está em
 * `docs/CONTRATO-OVERLAY.md`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { GameConfig } from '../config.js';
import type { GameEngine } from '../engine/gameEngine.js';
import type { Logger } from '../logger.js';
import type { GameAction, GameState } from '../types.js';
import { overlayPage } from './overlayPage.js';
import {
  PROTOCOL_VERSION,
  publicConfig,
  type PublicConfig,
  type ServerMessage,
} from './protocol.js';
import { normalizeSimulatedEvents } from './simulateInput.js';

type WsServer = InstanceType<typeof WebSocketServer>;

export interface GameServerOptions {
  engine: GameEngine;
  config: GameConfig;
  logger: Logger;
  /** Quando definido, POST /api/simulate exige o header `x-sim-token`. */
  simToken?: string;
}

export interface ServerAddress {
  host: string;
  port: number;
  httpUrl: string;
  wsUrl: string;
}

const HEARTBEAT_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;

export class GameServer {
  private readonly httpServer: Server;
  private readonly wss: WsServer;
  private readonly clients = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly publicConfig: PublicConfig;
  private readonly startedAt = Date.now();

  private seq = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private pendingState: GameState | null = null;
  private lastStateSentAt = 0;
  private closing = false;

  constructor(private readonly options: GameServerOptions) {
    this.publicConfig = publicConfig(options.config);

    this.httpServer = createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.wss.on('connection', (socket: WebSocket) => this.onConnection(socket));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async listen(): Promise<ServerAddress> {
    const { host, port } = this.options.config.overlay;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.httpServer.off('error', onError);
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(port, host);
    });

    const address = this.httpServer.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

    this.startHeartbeat();

    return {
      host,
      port: actualPort,
      httpUrl: `http://${displayHost}:${actualPort}`,
      wsUrl: `ws://${displayHost}:${actualPort}/ws`,
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.heartbeatTimer = null;
    this.stateTimer = null;

    for (const client of this.clients) {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /** Envia uma ação do personagem para todos os overlays conectados. */
  broadcastAction(action: GameAction): void {
    this.seq += 1;
    this.broadcast({
      v: PROTOCOL_VERSION,
      type: 'action',
      seq: this.seq,
      id: `action-${this.seq}`,
      ts: Date.now(),
      action,
    });
  }

  /** Envia o estado com throttle (padrão: 2x por segundo). */
  broadcastState(state: GameState): void {
    this.pendingState = state;
    const throttle = this.options.config.overlay.stateThrottleMs;
    const now = Date.now();

    if (now - this.lastStateSentAt >= throttle) {
      this.sendState(state);
      return;
    }

    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.pendingState) this.sendState(this.pendingState);
    }, Math.max(0, throttle - (now - this.lastStateSentAt)));
    this.stateTimer.unref?.();
  }

  // ---------------------------------------------------------------- WebSocket

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private onConnection(socket: WebSocket): void {
    this.clients.add(socket);
    this.alive.add(socket);

    socket.on('pong', () => this.alive.add(socket));
    socket.on('close', () => {
      this.clients.delete(socket);
      this.alive.delete(socket);
    });
    socket.on('error', () => {
      this.clients.delete(socket);
    });
    socket.on('message', (data) => this.onClientMessage(socket, data));

    this.send(socket, {
      v: PROTOCOL_VERSION,
      type: 'hello',
      serverTime: Date.now(),
      state: this.options.engine.getState(),
      config: this.publicConfig,
    });
  }

  private onClientMessage(socket: WebSocket, data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if ((parsed as { type?: unknown }).type === 'ping') {
      this.send(socket, { v: PROTOCOL_VERSION, type: 'pong', t: Date.now() });
    }
  }

  private sendState(state: GameState): void {
    this.lastStateSentAt = Date.now();
    this.pendingState = null;
    this.broadcast({ v: PROTOCOL_VERSION, type: 'state', state });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Cliente pode ter sumido entre o OPEN e o send.
    }
  }

  private broadcast(message: ServerMessage): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(payload);
      } catch {
        // ignore
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!this.alive.has(client)) {
          client.terminate();
          this.clients.delete(client);
          continue;
        }
        this.alive.delete(client);
        try {
          client.ping();
        } catch {
          client.terminate();
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  // ---------------------------------------------------------------- HTTP

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      this.json(res, 400, { error: 'URL inválida' });
      return;
    }

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-sim-token');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (
      method === 'GET' &&
      (url.pathname === '/' || url.pathname === '/overlay' || url.pathname === '/debug')
    ) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(overlayPage());
      return;
    }

    if (method === 'GET' && url.pathname === '/health') {
      this.json(res, 200, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        clients: this.clients.size,
        connection: this.options.engine.getState().connection,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/state') {
      this.json(res, 200, this.options.engine.getState());
      return;
    }

    if (method === 'GET' && url.pathname === '/config') {
      this.json(res, 200, this.publicConfig);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/simulate') {
      await this.handleSimulate(req, res);
      return;
    }

    this.json(res, 404, { error: 'not found' });
  }

  private async handleSimulate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.canSimulate(req)) {
      this.json(res, 403, { error: 'simulação desabilitada para esta origem' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      this.json(res, 400, {
        error: error instanceof Error ? error.message : 'corpo inválido',
      });
      return;
    }

    const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const input = Array.isArray(raw.events)
      ? raw.events
      : raw.event !== undefined
        ? [raw.event]
        : [raw];

    const events = normalizeSimulatedEvents(input);
    if (events.length === 0) {
      this.json(res, 422, { accepted: 0, error: 'nenhum evento válido' });
      return;
    }

    for (const event of events) this.options.engine.ingest(event);
    this.options.logger.info(`API: ${events.length} evento(s) simulado(s)`);
    this.json(res, 200, { accepted: events.length });
  }

  private canSimulate(req: IncomingMessage): boolean {
    const token = this.options.simToken;
    if (token) {
      return req.headers['x-sim-token'] === token;
    }
    return isLoopback(req.socket.remoteAddress);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(payload);
  }
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('corpo maior que 256 KB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });

    req.on('error', reject);
  });
}
