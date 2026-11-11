/**
 * Agendador de respostas do chat.
 *
 * Regras (todas configuráveis em `config/game.json`):
 *  - janela deslizante de 10 mensagens: pelo menos 4 precisam ser respondidas;
 *  - no máximo 6 respostas por janela, para o personagem não responder tudo;
 *  - cooldown global entre respostas (2,5 s por padrão);
 *  - cooldown por pessoa (20 s), para ninguém monopolizar o personagem;
 *  - quando a cota mínima está atrasada, a resposta fura o cooldown global
 *    (a garantia de 4/10 tem prioridade), mas respeita um piso por pessoa.
 *
 * O agendador só decide *quem* responder e *quando*; o texto é gerado pelo
 * `CharacterResponder`, de forma assíncrona.
 */
import type { Clock } from '../clock.js';
import type { ChatMetrics, Viewer } from '../types.js';

export interface ChatRecord {
  id: string;
  user: Viewer;
  text: string;
  ts: number;
  replied: boolean;
  /** Motivo quando a mensagem foi descartada antes de virar candidata. */
  dropped?: 'duplicate' | 'command' | 'short' | 'queue_full';
}

export interface ChatSchedulerOptions {
  windowSize: number;
  minRepliesPerWindow: number;
  maxRepliesPerWindow: number;
  cooldownMs: number;
  /** Piso de espaçamento mesmo quando a cota mínima está atrasada. */
  minReplyGapMs: number;
  perUserCooldownMs: number;
  sameUserFloorMs: number;
  duplicateWindowMs: number;
  maxQueue: number;
  minLength: number;
  ignoreCommands: boolean;
}

export type OfferResult =
  | { accepted: true; queued: number }
  | { accepted: false; reason: NonNullable<ChatRecord['dropped']> };

const SPREAD_MS = 250;
const MAX_TRACKED_USERS = 500;

export class ChatScheduler {
  private readonly window: ChatRecord[] = [];
  private readonly pending: ChatRecord[] = [];
  private readonly lastReplyByUser = new Map<string, number>();
  private readonly lastMessageByUser = new Map<string, { text: string; at: number }>();

  private lastReplyAt = Number.NEGATIVE_INFINITY;
  private timerAt: number | null = null;
  private timerHandle: unknown = null;

  private totalMessages = 0;
  private totalReplies = 0;
  private totalDropped = 0;
  private totalSkipped = 0;

  constructor(
    private readonly options: ChatSchedulerOptions,
    private readonly clock: Clock,
    private readonly onReply: (record: ChatRecord) => void,
  ) {}

  /**
   * Recebe uma mensagem do chat. Retorna `accepted: false` quando ela é
   * descartada por comando, tamanho, duplicata ou fila cheia.
   */
  offer(input: { id: string; user: Viewer; text: string; ts?: number }): OfferResult {
    const text = input.text?.trim() ?? '';

    if (text.length < this.options.minLength) return this.reject('short');
    if (this.options.ignoreCommands && /^[!\/]/.test(text)) return this.reject('command');

    const userKey = input.user.userId;
    const previous = this.lastMessageByUser.get(userKey);
    const normalized = text.toLowerCase();
    const now = input.ts ?? this.clock.now();

    if (
      previous &&
      previous.text === normalized &&
      now - previous.at <= this.options.duplicateWindowMs
    ) {
      return this.reject('duplicate');
    }
    this.lastMessageByUser.set(userKey, { text: normalized, at: now });
    if (this.lastMessageByUser.size > 1_000) {
      for (const [key, value] of this.lastMessageByUser) {
        if (now - value.at > this.options.duplicateWindowMs) this.lastMessageByUser.delete(key);
      }
    }

    const record: ChatRecord = {
      id: input.id,
      user: input.user,
      text,
      ts: now,
      replied: false,
    };

    this.window.push(record);
    this.pending.push(record);
    this.totalMessages += 1;

    while (this.window.length > this.options.windowSize) {
      const removed = this.window.shift();
      if (removed && !removed.replied) this.totalSkipped += 1;
    }

    // Fila cheia: descarta a mais antiga (e ela sai da janela, para não
    // derrubar a taxa de resposta por um problema operacional).
    while (this.pending.length > this.options.maxQueue) {
      const dropped = this.pending.shift();
      if (dropped) {
        dropped.dropped = 'queue_full';
        this.totalDropped += 1;
        this.removeFromWindow(dropped);
      }
    }

    this.pump();
    return { accepted: true, queued: this.pending.length };
  }

  /** Força uma tentativa de resposta (usado após eventos e em testes). */
  pump(): void {
    if (this.pending.length === 0) return;

    const now = this.clock.now();
    const { windowSize, minRepliesPerWindow, maxRepliesPerWindow, cooldownMs, minReplyGapMs } =
      this.options;
    const replies = this.window.reduce((total, record) => total + (record.replied ? 1 : 0), 0);
    const messages = Math.min(this.window.length, windowSize);
    const target = Math.min(minRepliesPerWindow, messages);
    const deficit = Math.max(0, target - replies);
    const capReached = replies >= maxRepliesPerWindow;
    const sinceLastReply = now - this.lastReplyAt;

    const mustReply = deficit > 0 && !capReached;
    const mayReply =
      !mustReply && !capReached && sinceLastReply >= Math.max(cooldownMs, minReplyGapMs);

    if (!mustReply && !mayReply) {
      // Teto da janela atingido: espera a janela deslizar (novas mensagens)
      // em vez de reagendar em loop.
      if (capReached) return;
      this.scheduleAt(this.lastReplyAt + Math.max(cooldownMs, minReplyGapMs));
      return;
    }

    // A cota fura o cooldown global, mas não o piso de espaçamento: rajadas
    // não podem virar 4 balões em 1 segundo.
    if (mustReply && sinceLastReply < minReplyGapMs) {
      this.scheduleAt(this.lastReplyAt + minReplyGapMs);
      return;
    }

    const candidate = this.selectCandidate(mustReply);
    if (!candidate) return;

    this.reply(candidate, now);

    // Continua respondendo até cumprir a cota mínima, espaçando as falas.
    if (deficit - 1 > 0 && this.pending.length > 0) {
      this.scheduleAt(this.clock.now() + SPREAD_MS);
    } else {
      this.scheduleAt(this.clock.now() + Math.max(cooldownMs, minReplyGapMs));
    }
  }

  metrics(): ChatMetrics {
    const answered = this.window.reduce((total, record) => total + (record.replied ? 1 : 0), 0);
    const messagesInWindow = this.window.length;
    return {
      windowSize: this.options.windowSize,
      messagesInWindow,
      repliesInWindow: answered,
      target: Math.min(this.options.minRepliesPerWindow, messagesInWindow),
      totalMessages: this.totalMessages,
      totalReplies: this.totalReplies,
      totalSkipped: this.totalSkipped,
      totalDropped: this.totalDropped,
      replyRate: messagesInWindow === 0 ? 0 : Number((answered / messagesInWindow).toFixed(2)),
    };
  }

  /** Últimas mensagens (mais antigas primeiro), para contexto do LLM. */
  recentMessages(limit = 5): string[] {
    return this.window
      .slice(-limit)
      .map((record) => `${record.user.nickname}: ${record.text}`);
  }

  dispose(): void {
    if (this.timerHandle !== null) {
      this.clock.clearTimeout(this.timerHandle);
      this.timerHandle = null;
      this.timerAt = null;
    }
  }

  private reply(record: ChatRecord, now: number): void {
    const index = this.pending.indexOf(record);
    if (index >= 0) this.pending.splice(index, 1);

    record.replied = true;
    this.lastReplyAt = now;
    this.totalReplies += 1;
    this.lastReplyByUser.set(record.user.userId, now);
    this.pruneUsers(now);

    try {
      this.onReply(record);
    } catch {
      // Um erro do responder não pode derrubar o motor; a resposta já conta.
    }
  }

  /**
   * Escolhe a mensagem mais antiga cuja pessoa não está em cooldown.
   * Em modo "must" (cota atrasada), se todo mundo estiver em cooldown por
   * pessoa, ainda assim responde — respeitando o piso `sameUserFloorMs`.
   */
  private selectCandidate(mustReply: boolean): ChatRecord | null {
    const now = this.clock.now();
    const { perUserCooldownMs, sameUserFloorMs } = this.options;

    for (const record of this.pending) {
      const last = this.lastReplyByUser.get(record.user.userId);
      if (last === undefined || now - last >= perUserCooldownMs) return record;
    }

    if (!mustReply) {
      this.scheduleAt(this.nextEligibleAt(now));
      return null;
    }

    const sorted = [...this.pending].sort(
      (a, b) =>
        (this.lastReplyByUser.get(a.user.userId) ?? Number.NEGATIVE_INFINITY) -
        (this.lastReplyByUser.get(b.user.userId) ?? Number.NEGATIVE_INFINITY),
    );
    const best = sorted[0];
    if (!best) return null;

    const last = this.lastReplyByUser.get(best.user.userId) ?? Number.NEGATIVE_INFINITY;
    if (now - last < sameUserFloorMs) {
      this.scheduleAt(last + sameUserFloorMs);
      return null;
    }
    return best;
  }

  private nextEligibleAt(now: number): number {
    let earliest = now + 1000;
    for (const record of this.pending) {
      const last = this.lastReplyByUser.get(record.user.userId);
      if (last === undefined) {
        earliest = Math.min(earliest, now + SPREAD_MS);
        continue;
      }
      earliest = Math.min(earliest, last + this.options.perUserCooldownMs);
    }
    return earliest;
  }

  private scheduleAt(at: number): void {
    const now = this.clock.now();
    const delay = Math.max(0, at - now);
    if (this.timerAt !== null && this.timerAt <= at) return;

    if (this.timerHandle !== null) this.clock.clearTimeout(this.timerHandle);
    this.timerAt = at;
    this.timerHandle = this.clock.setTimeout(() => {
      this.timerHandle = null;
      this.timerAt = null;
      this.pump();
    }, delay);
  }

  private reject(reason: NonNullable<ChatRecord['dropped']>): OfferResult {
    this.totalDropped += 1;
    return { accepted: false, reason };
  }

  private removeFromWindow(record: ChatRecord): void {
    const index = this.window.indexOf(record);
    if (index >= 0) this.window.splice(index, 1);
  }

  private pruneUsers(now: number): void {
    if (this.lastReplyByUser.size <= MAX_TRACKED_USERS) return;
    for (const [userId, at] of this.lastReplyByUser) {
      if (now - at > 10 * 60_000) this.lastReplyByUser.delete(userId);
    }
  }
}
