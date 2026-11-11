/**
 * Motor do jogo.
 *
 * Recebe eventos normalizados de qualquer origem (TikTok Live, simulador,
 * testes) e transforma em ações para o overlay + um snapshot de estado que o
 * visual usa para HUD, ranking e barra de meta.
 *
 * Regras implementadas:
 *  1. Doação (presente) → ação/animacão do personagem, com faixas de valor.
 *  2. Curtidas a cada 100 → ação de "hype".
 *  3. Presente acima de 1000 moedas → personagem responde nominalmente.
 *  4. Chat → respostas com cooldown garantindo pelo menos 4 de 10 mensagens.
 */
import type { Clock } from '../clock.js';
import type { DonationTier, GameConfig, LinesConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type {
  ActionData,
  ActionReason,
  ChatEvent,
  GameAction,
  GameState,
  LeaderboardEntry,
  LikeEvent,
  LiveEvent,
  SocialEvent,
  Viewer,
  ViewersEvent,
} from '../types.js';
import { ChatScheduler, type ChatRecord } from './chatScheduler.js';
import { GiftCombiner, type CombinedGift } from './giftCombiner.js';
import type { CharacterResponder, SayContent } from './responder.js';

export interface PersistedSession {
  version: 1;
  savedAt: number;
  totals: GameState['totals'];
  leaderboard: LeaderboardEntry[];
  like: { total: number; milestone: number; buffer: number };
  goalReached: boolean;
}

export interface GameEngineOptions {
  config: GameConfig;
  lines: LinesConfig;
  clock: Clock;
  responder: CharacterResponder;
  logger: Logger;
  onAction: (action: GameAction) => void;
  onState?: (state: GameState) => void;
  /** Restaura totais de uma sessão anterior. */
  session?: PersistedSession | null;
}

const MAX_LEADERBOARD_ENTRIES = 250;
const MAX_LEADERBOARD_DISPLAY = 5;

function shorten(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Maior faixa cujo `minCoins` cabe no valor doado. */
export function tierForCoins(tiers: DonationTier[], coins: number): DonationTier {
  let selected = tiers[0];
  for (const tier of tiers) {
    if (coins >= tier.minCoins) selected = tier;
    else break;
  }
  // `tiers` nunca é vazio (validação do schema), mas o TS não sabe.
  if (!selected) throw new Error('donation.tiers vazio');
  return selected;
}

export class GameEngine {
  private readonly config: GameConfig;
  private readonly clock: Clock;
  private readonly responder: CharacterResponder;
  private readonly logger: Logger;
  private readonly onAction: (action: GameAction) => void;
  private readonly onState: ((state: GameState) => void) | undefined;
  private readonly chat: ChatScheduler;
  private readonly gifts: GiftCombiner;
  private readonly leaderboard = new Map<string, LeaderboardEntry>();

  private readonly startedAt: number;
  private updatedAt: number;

  private readonly totals: GameState['totals'] = {
    coins: 0,
    gifts: 0,
    likes: 0,
    messages: 0,
    replies: 0,
    followers: 0,
    shares: 0,
    subscribers: 0,
  };

  private likeBuffer = 0;
  private likeMilestone = 0;
  private goalReached = false;
  private viewers = 0;
  private connection: GameState['connection'] = {
    status: 'disconnected',
    room: null,
    viewers: 0,
    message: null,
  };
  private lastAction: GameState['lastAction'] = null;
  private chatSayChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: GameEngineOptions) {
    this.config = options.config;
    this.clock = options.clock;
    this.responder = options.responder;
    this.logger = options.logger;
    this.onAction = options.onAction;
    this.onState = options.onState;
    this.startedAt = this.clock.now();
    this.updatedAt = this.startedAt;

    const chatConfig = this.config.chat;
    this.chat = new ChatScheduler(
      {
        windowSize: chatConfig.windowSize,
        minRepliesPerWindow: chatConfig.minRepliesPerWindow,
        maxRepliesPerWindow: chatConfig.maxRepliesPerWindow,
        cooldownMs: chatConfig.cooldownMs,
        minReplyGapMs: chatConfig.minReplyGapMs,
        perUserCooldownMs: chatConfig.perUserCooldownMs,
        sameUserFloorMs: chatConfig.sameUserFloorMs,
        duplicateWindowMs: chatConfig.duplicateWindowMs,
        maxQueue: chatConfig.maxQueue,
        minLength: chatConfig.minLength,
        ignoreCommands: chatConfig.ignoreCommands,
      },
      this.clock,
      (record) => this.handleChatReply(record),
    );

    this.gifts = new GiftCombiner(
      this.clock,
      this.config.gifts.comboFlushMs,
      (gift) => this.registerGift(gift),
    );

    if (options.session) this.restore(options.session);
    if (this.config.room.uniqueId) this.connection.room = this.config.room.uniqueId;
  }

  // ---------------------------------------------------------------- entrada

  ingest(event: LiveEvent): void {
    if (this.disposed) return;

    switch (event.type) {
      case 'chat':
        this.onChat(event);
        break;
      case 'gift':
        this.gifts.push(event);
        break;
      case 'like':
        this.onLike(event);
        break;
      case 'follow':
      case 'share':
      case 'subscribe':
      case 'join':
        this.onSocial(event);
        break;
      case 'viewers':
        this.onViewers(event);
        break;
    }
  }

  setConnection(
    status: GameState['connection']['status'],
    details: { room?: string | null; message?: string | null } = {},
  ): void {
    this.connection = {
      status,
      room: details.room !== undefined ? details.room : this.connection.room,
      message: details.message ?? null,
      viewers: this.viewers,
    };
    this.emitState();
  }

  // ---------------------------------------------------------------- estado

  getState(): GameState {
    const { donation, likes } = this.config;
    return {
      protocol: 1,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      connection: { ...this.connection },
      totals: { ...this.totals },
      like: {
        total: this.totals.likes,
        milestone: this.likeMilestone,
        nextMilestone: (this.likeMilestone + 1) * likes.step,
        progress: Number((this.likeBuffer / likes.step).toFixed(3)),
      },
      chat: this.chat.metrics(),
      goal: {
        enabled: donation.goal.enabled,
        targetCoins: donation.goal.targetCoins,
        reached: this.goalReached,
        progress: Number((this.totals.coins / donation.goal.targetCoins).toFixed(3)),
      },
      leaderboard: this.topDonors(MAX_LEADERBOARD_DISPLAY),
      lastAction: this.lastAction ? { ...this.lastAction } : null,
    };
  }

  snapshot(): PersistedSession {
    return {
      version: 1,
      savedAt: this.clock.now(),
      totals: { ...this.totals },
      leaderboard: this.topDonors(MAX_LEADERBOARD_ENTRIES),
      like: {
        total: this.totals.likes,
        milestone: this.likeMilestone,
        buffer: this.likeBuffer,
      },
      goalReached: this.goalReached,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.chat.dispose();
    this.gifts.dispose();
  }

  // ---------------------------------------------------------------- chat

  private onChat(event: ChatEvent): void {
    if (!this.connection.room && this.config.room.uniqueId) {
      this.connection.room = this.config.room.uniqueId;
    }

    const result = this.chat.offer({
      id: event.id,
      user: event.user,
      text: event.text,
      ts: event.ts || this.clock.now(),
    });
    if (result.accepted) this.totals.messages += 1;

    this.emitState();
  }

  private handleChatReply(record: ChatRecord): void {
    this.totals.replies += 1;
    const history = this.chat.recentMessages(5);

    // Encadeia as falas para o balão aparecer na mesma ordem das decisões,
    // mesmo quando o LLM responde com latências diferentes.
    this.chatSayChain = this.chatSayChain
      .then(async () => {
        if (this.disposed) return;
        const content = await this.responder.answerChat({
          user: record.user,
          text: record.text,
          coins: this.totals.coins,
          history,
        });
        this.emitSay('chat', content, record.user, {
          chatMessageId: record.id,
          intent: content.intent,
        });
        this.logger.info(
          `Chat: @${record.user.username} "${shorten(record.text)}" → "${content.text}"`,
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Falha ao responder o chat: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  // ---------------------------------------------------------------- presentes

  private registerGift(gift: CombinedGift): void {
    const coins = this.coinValue(gift.giftId, gift.diamonds) * gift.repeatCount;
    if (coins <= 0) return;

    this.totals.coins += coins;
    this.totals.gifts += 1;
    this.addToLeaderboard(gift.user, coins);

    const tier = tierForCoins(this.config.donation.tiers, coins);
    const { expensiveGift, donation } = this.config;
    const isExpensive = expensiveGift.enabled && coins > expensiveGift.minCoinsExclusive;
    const data: ActionData = {
      coins,
      tier: tier.id,
      gift: gift.giftName,
      giftId: gift.giftId,
      repeat: gift.repeatCount,
    };

    if (isExpensive) {
      this.emitAct(
        'expensive_gift',
        expensiveGift.animation,
        expensiveGift.intensity,
        gift.user,
        data,
      );
      if (expensiveGift.speak) {
        void this.safeSay('expensive_gift', gift.user, data, () =>
          this.responder.expensiveGift({
            user: gift.user,
            giftName: gift.giftName,
            coins,
            tier: tier.id,
            repeat: gift.repeatCount,
          }),
        );
      }
    } else {
      this.emitAct('donation', tier.animation, tier.intensity, gift.user, data);
      if (donation.speakFromCoins > 0 && coins >= donation.speakFromCoins) {
        void this.safeSay('donation', gift.user, data, () =>
          this.responder.thankGift({
            user: gift.user,
            giftName: gift.giftName,
            coins,
            tier: tier.id,
            repeat: gift.repeatCount,
          }),
        );
      }
    }

    this.logger.info(
      `Presente: ${gift.giftName} x${gift.repeatCount} de @${gift.user.username} = ${coins} moedas`,
    );

    this.checkGoal();
    this.emitState();
  }

  /** Moedas de UMA unidade do presente (override > diamantes × cotação). */
  private coinValue(giftId: string, diamonds: number): number {
    const override = this.config.coins.overrides[giftId];
    if (typeof override === 'number' && Number.isFinite(override)) return Math.round(override);
    return Math.round(diamonds * this.config.coins.perDiamond);
  }

  private checkGoal(): void {
    const goal = this.config.donation.goal;
    if (!goal.enabled || this.goalReached) return;
    if (this.totals.coins < goal.targetCoins) return;

    this.goalReached = true;
    this.emitAct('goal', goal.animation, 5, undefined, {
      coins: this.totals.coins,
      target: goal.targetCoins,
    });

    if (goal.announce) {
      this.emitSay('goal', this.responder.celebrateGoal({
        coins: this.totals.coins,
        target: goal.targetCoins,
      }));
    }

    this.logger.info(`Meta de ${goal.targetCoins} moedas batida (${this.totals.coins})`);
  }

  // ---------------------------------------------------------------- curtidas

  private onLike(event: LikeEvent): void {
    const count = Math.max(0, event.count);
    if (count === 0) return;

    const step = this.config.likes.step;
    this.totals.likes += count;
    this.likeBuffer += count;

    const milestones = Math.floor(this.likeBuffer / step);
    if (milestones > 0) {
      this.likeBuffer -= milestones * step;
      const first = this.likeMilestone + 1;
      this.likeMilestone += milestones;

      const toAnimate = Math.min(milestones, this.config.likes.maxMilestonesPerEvent);
      for (let i = 0; i < toAnimate; i++) {
        this.emitAct(
          'like_milestone',
          this.config.likes.animation,
          this.config.likes.intensity,
          event.user,
          {
            milestone: first + i,
            step,
            totalLikes: this.totals.likes,
          },
        );
      }

      this.logger.info(
        `+${count} curtidas → marco ${this.likeMilestone} (total ${this.totals.likes})`,
      );
    }

    this.emitState();
  }

  // ---------------------------------------------------------------- social

  private onSocial(event: SocialEvent): void {
    const social = this.config.social;

    switch (event.type) {
      case 'follow':
        this.totals.followers += 1;
        this.emitAct('follow', social.followAnimation, 2, event.user, {});
        if (social.announceFollows) {
          this.emitSay('follow', this.responder.welcomeSocial('follow', event.user, this.totals.coins));
        }
        break;
      case 'share':
        this.totals.shares += 1;
        this.emitAct('share', social.shareAnimation, 2, event.user, {});
        break;
      case 'subscribe':
        this.totals.subscribers += 1;
        this.emitAct('subscribe', social.subscribeAnimation, 3, event.user, {});
        this.emitSay('subscribe', this.responder.welcomeSocial('subscribe', event.user, this.totals.coins));
        break;
      case 'join':
        if (social.announceJoins) {
          this.emitAct('join', social.joinAnimation, 1, event.user, {});
        }
        break;
    }

    this.emitState();
  }

  private onViewers(event: ViewersEvent): void {
    this.viewers = Math.max(0, event.count);
    this.connection = { ...this.connection, viewers: this.viewers };
    this.emitState();
  }

  // ---------------------------------------------------------------- ranking

  private addToLeaderboard(user: Viewer, coins: number): void {
    if (coins <= 0) return;
    const current = this.leaderboard.get(user.userId);
    if (current) {
      current.coins += coins;
      current.gifts += 1;
      current.user = user;
    } else {
      this.leaderboard.set(user.userId, { user, coins, gifts: 1 });
    }

    if (this.leaderboard.size > MAX_LEADERBOARD_ENTRIES) {
      const smallest = [...this.leaderboard.entries()].sort((a, b) => a[1].coins - b[1].coins)[0];
      if (smallest) this.leaderboard.delete(smallest[0]);
    }
  }

  private topDonors(limit: number): LeaderboardEntry[] {
    return [...this.leaderboard.values()]
      .sort((a, b) => b.coins - a.coins || b.gifts - a.gifts)
      .slice(0, limit)
      .map((entry) => ({ ...entry, user: { ...entry.user } }));
  }

  // ---------------------------------------------------------------- saída

  private emitAct(
    reason: ActionReason,
    animation: string,
    intensity: number,
    user?: Viewer,
    data: ActionData = {},
  ): void {
    this.emit({
      kind: 'character.act',
      reason,
      animation,
      intensity: Math.max(1, Math.min(5, Math.round(intensity))),
      ...(user ? { user } : {}),
      data,
    });
  }

  private emitSay(
    reason: ActionReason,
    content: SayContent,
    user?: Viewer,
    data: ActionData = {},
  ): void {
    if (!content.text) return;
    this.emit({
      kind: 'character.say',
      reason,
      text: content.text,
      emotion: content.emotion,
      ...(user ? { user } : {}),
      data,
    });
  }

  private async safeSay(
    reason: ActionReason,
    user: Viewer,
    data: ActionData,
    producer: () => Promise<SayContent> | SayContent,
  ): Promise<void> {
    try {
      const content = await producer();
      this.emitSay(reason, content, user, data);
    } catch (error) {
      this.logger.warn(
        `Falha ao gerar fala (${reason}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private emit(action: GameAction): void {
    if (this.disposed) return;
    this.updatedAt = this.clock.now();
    this.lastAction = { ts: this.updatedAt, kind: action.kind, reason: action.reason };

    try {
      this.onAction(action);
    } catch (error) {
      this.logger.warn(
        `Falha ao entregar ação: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.emitState();
  }

  private emitState(): void {
    if (!this.onState || this.disposed) return;
    this.updatedAt = this.clock.now();
    try {
      this.onState(this.getState());
    } catch (error) {
      this.logger.warn(
        `Falha ao emitir estado: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private restore(session: PersistedSession): void {
    const numeric = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

    for (const key of Object.keys(this.totals) as Array<keyof typeof this.totals>) {
      this.totals[key] = Math.floor(numeric(session.totals?.[key]));
    }

    this.likeMilestone = Math.floor(numeric(session.like?.milestone));
    this.likeBuffer = numeric(session.like?.buffer);
    this.goalReached = session.goalReached === true;

    for (const entry of session.leaderboard ?? []) {
      if (!entry?.user?.userId) continue;
      this.leaderboard.set(entry.user.userId, {
        user: entry.user,
        coins: numeric(entry.coins),
        gifts: numeric(entry.gifts),
      });
    }
  }
}
