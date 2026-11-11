/**
 * Tipos centrais do jogo.
 *
 * Tudo que entra no motor é um `LiveEvent` já normalizado — assim o motor não
 * conhece TikTok, simulador ou qualquer outra fonte. Tudo que sai é um
 * `GameAction`, que o overlay (feito em outra IA/ferramenta) consome via
 * WebSocket para animar o personagem.
 */

/** Pessoa que interagiu com a live. */
export interface Viewer {
  /** ID numérico/estável do TikTok. */
  userId: string;
  /** @handle sem o "@". */
  username: string;
  /** Nome exibido no chat. */
  nickname: string;
  avatarUrl?: string;
}

interface BaseEvent {
  /** ID único do evento na origem (msgId do TikTok ou gerado pelo simulador). */
  id: string;
  /** Timestamp em ms (epoch). */
  ts: number;
}

export interface ChatEvent extends BaseEvent {
  type: 'chat';
  user: Viewer;
  text: string;
}

export interface GiftEvent extends BaseEvent {
  type: 'gift';
  user: Viewer;
  giftId: string;
  giftName: string;
  iconUrl?: string;
  /** Valor unitário do presente em diamantes (como o TikTok envia). */
  diamonds: number;
  /** Quantas unidades foram enviadas neste combo (1 quando não é combo). */
  repeatCount: number;
  /** true quando o combo terminou (repeatEnd) ou o presente não é de combo. */
  comboEnd: boolean;
  /** Presentes de combo (streakable) chegam em várias mensagens. */
  streakable: boolean;
}

export interface LikeEvent extends BaseEvent {
  type: 'like';
  user: Viewer;
  /** Curtidas contidas nesta mensagem (o TikTok agrupa em lotes). */
  count: number;
  /** Total acumulado na sala, quando a origem informa. */
  totalLikes?: number;
}

export type SocialKind = 'follow' | 'share' | 'subscribe' | 'join';

export interface SocialEvent extends BaseEvent {
  type: SocialKind;
  user: Viewer;
}

export interface ViewersEvent extends BaseEvent {
  type: 'viewers';
  count: number;
}

export type LiveEvent =
  | ChatEvent
  | GiftEvent
  | LikeEvent
  | SocialEvent
  | ViewersEvent;

/** Por que o personagem está reagindo. */
export type ActionReason =
  | 'donation'
  | 'expensive_gift'
  | 'like_milestone'
  | 'chat'
  | 'follow'
  | 'share'
  | 'subscribe'
  | 'join'
  | 'goal'
  | 'system';

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'excited'
  | 'grateful'
  | 'surprised'
  | 'playful'
  | 'shy';

/** Dados extras, sempre serializáveis (vão por WebSocket). */
export type ActionData = Record<string, string | number | boolean | null>;

/** Dispara uma animação no personagem. */
export interface CharacterAct {
  kind: 'character.act';
  reason: ActionReason;
  /** Nome da animação que o overlay deve tocar (ex.: "dance", "bow"). */
  animation: string;
  /** 1 (leve) a 5 (épico) — útil para priorizar/tamanho do efeito. */
  intensity: number;
  user?: Viewer;
  data: ActionData;
}

/** Fala do personagem (balão de texto). */
export interface CharacterSay {
  kind: 'character.say';
  reason: ActionReason;
  text: string;
  emotion: Emotion;
  user?: Viewer;
  data: ActionData;
}

export type GameAction = CharacterAct | CharacterSay;

export interface LeaderboardEntry {
  user: Viewer;
  coins: number;
  gifts: number;
}

export interface ChatMetrics {
  /** Tamanho da janela deslizante (10 por padrão). */
  windowSize: number;
  /** Quantas mensagens existem na janela agora. */
  messagesInWindow: number;
  /** Quantas dessas mensagens já foram respondidas. */
  repliesInWindow: number;
  /** Meta mínima de respostas dentro da janela (4 por padrão). */
  target: number;
  totalMessages: number;
  totalReplies: number;
  totalSkipped: number;
  totalDropped: number;
  /** Taxa de resposta na janela atual (0..1). */
  replyRate: number;
}

export interface GameState {
  protocol: 1;
  startedAt: number;
  updatedAt: number;
  connection: {
    status: 'connecting' | 'connected' | 'disconnected' | 'error';
    room: string | null;
    viewers: number;
    message: string | null;
  };
  totals: {
    coins: number;
    gifts: number;
    likes: number;
    messages: number;
    replies: number;
    followers: number;
    shares: number;
    subscribers: number;
  };
  like: {
    total: number;
    milestone: number;
    nextMilestone: number;
    /** 0..1 até a próxima virada de 100 curtidas. */
    progress: number;
  };
  chat: ChatMetrics;
  goal: {
    enabled: boolean;
    targetCoins: number;
    reached: boolean;
    /** 0..1 (ou >1 se passou da meta). */
    progress: number;
  };
  leaderboard: LeaderboardEntry[];
  lastAction: { ts: number; kind: GameAction['kind']; reason: ActionReason } | null;
}
