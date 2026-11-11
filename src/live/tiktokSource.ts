/**
 * Adaptador para o TikTok LIVE (Webcast).
 *
 * O TikTok não expõe um webhook público de chat/presentes para qualquer conta:
 * as bibliotecas de terceiros abrem o WebSocket do Webcast e decodificam as
 * mensagens. Aqui usamos `tiktok-live-connector` (v2), que exige uma chave de
 * assinatura do Euler Stream (plano gratuito serve para testar).
 *
 * Toda a "sujeira" do formato do TikTok fica neste arquivo: o motor recebe
 * apenas `LiveEvent` normalizado.
 */
import type { GiftEvent, LikeEvent, LiveEvent, SocialEvent, Viewer } from '../types.js';
import type { LiveSource, LiveSourceContext, LiveSourceStatus } from './liveSource.js';

/** Payloads do Webcast são enormes e mudam sem aviso; aqui só o que usamos. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

interface TikTokConnection {
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: Raw[]) => void): unknown;
}

export interface TikTokSourceOptions extends LiveSourceContext {
  uniqueId: string;
  /** Chave do Euler Stream (https://eulerstream.com). */
  signApiKey?: string;
  /** Cookie `sessionid` de uma conta logada (opcional, melhora o chat). */
  sessionId?: string;
  /** Cookie `tt-target-idc` (obrigatório junto com sessionId). */
  ttTargetIdc?: string;
  /** Busca a lista de presentes da sala (necessário para valores de alguns gifts). */
  fetchGiftInfo?: boolean;
  /** Espera entre tentativas de reconexão. */
  reconnectMs?: number;
}

const DEFAULT_RECONNECT_MS = 30_000;

export class TikTokSource implements LiveSource {
  readonly name = 'tiktok';

  private connection: TikTokConnection | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(private readonly options: TikTokSourceOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        await connection.disconnect();
      } catch {
        // Já pode estar desconectado.
      }
    }
  }

  private async connect(): Promise<void> {
    this.status({ status: 'connecting' });

    let TikTokLiveConnection: new (uniqueId: string, options?: Raw) => TikTokConnection;
    try {
      const mod = (await import('tiktok-live-connector')) as unknown as {
        TikTokLiveConnection: new (uniqueId: string, options?: Raw) => TikTokConnection;
      };
      TikTokLiveConnection = mod.TikTokLiveConnection;
    } catch (error) {
      this.fail(
        `Pacote tiktok-live-connector indisponível: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const connectionOptions: Raw = {};
    if (this.options.signApiKey) connectionOptions.signApiKey = this.options.signApiKey;
    if (this.options.sessionId) {
      connectionOptions.authenticateWs = false;
      connectionOptions.session = {
        cookie: {
          type: 'cookie',
          value: {
            sessionId: this.options.sessionId,
            ttTargetIdc: this.options.ttTargetIdc ?? 'useast1a',
          },
        },
      };
    }
    if (this.options.fetchGiftInfo) connectionOptions.enableExtendedGiftInfo = true;

    const connection = new TikTokLiveConnection(this.options.uniqueId, connectionOptions);
    this.connection = connection;
    this.wire(connection);

    try {
      await connection.connect();
      this.options.logger.info(`Conectado à live @${this.options.uniqueId}`);
    } catch (error) {
      this.fail(
        `Não foi possível conectar em @${this.options.uniqueId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleRetry();
    }
  }

  private wire(connection: TikTokConnection): void {
    connection.on('connected', (state: Raw) => {
      const roomId = state?.roomId ? String(state.roomId) : this.options.uniqueId;
      this.status({ status: 'connected', room: roomId });
    });

    connection.on('disconnected', (payload: Raw) => {
      this.status({
        status: 'disconnected',
        message: payload?.reason ? String(payload.reason) : `código ${payload?.code ?? '?'}`,
      });
      this.scheduleRetry();
    });

    connection.on('error', (error: Raw) => {
      this.status({ status: 'error', message: describeError(error) });
    });

    connection.on('streamEnd', () => {
      this.status({ status: 'disconnected', message: 'live encerrada' });
      this.scheduleRetry();
    });

    connection.on('chat', (message: Raw) => {
      const user = toViewer(message?.user);
      if (!user) return;
      const text = typeof message?.content === 'string' ? message.content : '';
      this.emit({ type: 'chat', id: this.id(message), ts: Date.now(), user, text });
    });

    connection.on('gift', (message: Raw) => {
      const user = toViewer(message?.user);
      if (!user) return;

      const gift = message?.gift ?? {};
      const giftId = String(gift.id ?? message?.giftId ?? '0');
      const giftName = String(gift.name ?? message?.giftName ?? 'Presente');
      const diamonds =
        Number(gift.diamondCount ?? message?.extendedGiftInfo?.diamond_count ?? message?.diamondCount ?? 0) ||
        0;
      const streakable = gift.type === 1 || gift.combo === true;
      const repeatCount = Math.max(1, Number(message?.repeatCount ?? 1) || 1);
      const comboEnd = !streakable || Boolean(message?.repeatEnd);
      const icon = gift?.icon?.urlList?.[0] ?? gift?.image?.urlList?.[0];

      const event: GiftEvent = {
        type: 'gift',
        id: this.id(message),
        ts: Date.now(),
        user,
        giftId,
        giftName,
        diamonds,
        repeatCount,
        comboEnd,
        streakable,
        ...(typeof icon === 'string' ? { iconUrl: icon } : {}),
      };
      this.emit(event);
    });

    connection.on('like', (message: Raw) => {
      const user = toViewer(message?.user);
      if (!user) return;
      const count = Math.max(0, Number(message?.count ?? 1) || 0);
      if (count === 0) return;
      const total = Number(message?.total);
      const event: LikeEvent = {
        type: 'like',
        id: this.id(message),
        ts: Date.now(),
        user,
        count,
        ...(Number.isFinite(total) ? { totalLikes: total } : {}),
      };
      this.emit(event);
    });

    connection.on('follow', (message: Raw) => this.social('follow', message));
    connection.on('share', (message: Raw) => this.social('share', message));
    connection.on('subNotify', (message: Raw) => this.social('subscribe', message));
    connection.on('subscribe', (message: Raw) => this.social('subscribe', message));
    connection.on('member', (message: Raw) => this.social('join', message));

    connection.on('roomUser', (message: Raw) => {
      const total = Number(message?.total ?? message?.totalUser);
      if (!Number.isFinite(total)) return;
      this.emit({
        type: 'viewers',
        id: this.id(message),
        ts: Date.now(),
        count: total,
      });
    });
  }

  private social(type: SocialEvent['type'], message: Raw): void {
    const user = toViewer(message?.user);
    if (!user) return;
    this.emit({ type, id: this.id(message), ts: Date.now(), user });
  }

  private emit(event: LiveEvent): void {
    if (this.stopped) return;
    this.options.onEvent(event);
  }

  private status(status: LiveSourceStatus): void {
    this.options.onStatus(status);
  }

  private fail(message: string): void {
    this.options.logger.error(message);
    this.status({ status: 'error', message });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.options.reconnectMs ?? DEFAULT_RECONNECT_MS;
    this.options.logger.info(`Nova tentativa de conexão em ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  private id(message: Raw): string {
    const msgId = message?.common?.msgId ?? message?.msgId;
    if (typeof msgId === 'string' && msgId.length > 0) return msgId;
    if (typeof msgId === 'number') return String(msgId);
    return `${Date.now()}-${++this.seq}`;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const info = (error as { info?: unknown }).info;
    if (typeof info === 'string' && info.length > 0) return info;
  }
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json;
  } catch {
    // Objeto circular: cai no String().
  }
  return String(error);
}

function toViewer(raw: Raw): Viewer | null {
  if (!raw) return null;
  const id = raw.id ?? raw.userId ?? raw.uniqueId;
  if (id === undefined || id === null || String(id).length === 0) return null;

  const username = String(raw.displayId ?? raw.uniqueId ?? id);
  const nickname = String(raw.nickname ?? username);
  const avatar =
    raw.avatarThumb?.urlList?.[0] ??
    raw.avatarMedium?.urlList?.[0] ??
    raw.avatarLarge?.urlList?.[0];

  return {
    userId: String(id),
    username,
    nickname,
    ...(typeof avatar === 'string' ? { avatarUrl: avatar } : {}),
  };
}
