/**
 * Fonte simulada: gera chat, curtidas, presentes, follows e espectadores.
 *
 * Serve para desenvolver o overlay e testar as regras sem estar ao vivo.
 * Os valores em diamantes são aproximados dos presentes reais do TikTok — o
 * valor oficial sempre vem do Webcast/conector.
 */
import type { GiftEvent, LiveEvent, SocialEvent, Viewer } from '../types.js';
import type { LiveSource, LiveSourceContext, LiveSourceStatus } from './liveSource.js';

export interface SimulatedSourceOptions extends LiveSourceContext {
  /** Intervalo entre eventos (ms). */
  intervalMs?: number;
  /** Semente para reproducibilidade. */
  seed?: number;
  /** A cada N eventos, força um presente caro (>1000 moedas). */
  expensiveEvery?: number;
}

interface GiftCatalogItem {
  id: string;
  name: string;
  diamonds: number;
  weight: number;
}

const GIFT_CATALOG: GiftCatalogItem[] = [
  { id: '5655', name: 'Rosa', diamonds: 1, weight: 30 },
  { id: '5827', name: 'TikTok', diamonds: 1, weight: 20 },
  { id: '6261', name: 'Coração com Dedos', diamonds: 5, weight: 15 },
  { id: '5658', name: 'Perfume', diamonds: 20, weight: 10 },
  { id: '6417', name: 'Corações', diamonds: 50, weight: 8 },
  { id: '6764', name: 'Óculos de Sol', diamonds: 100, weight: 6 },
  { id: '6260', name: 'Coração Gigante', diamonds: 500, weight: 4 },
  { id: '9828', name: 'Leão', diamonds: 29_999, weight: 1 },
];

const USERS: Viewer[] = [
  { userId: '1001', username: 'bia_tv', nickname: 'Bia' },
  { userId: '1002', username: 'lucasplays', nickname: 'Lucas' },
  { userId: '1003', username: 'nanda', nickname: 'Nanda' },
  { userId: '1004', username: 'pedrao', nickname: 'Pedrão' },
  { userId: '1005', username: 'juh', nickname: 'Juh' },
  { userId: '1006', username: 'rafa_dev', nickname: 'Rafa' },
  { userId: '1007', username: 'duda', nickname: 'Duda' },
  { userId: '1008', username: 'gui', nickname: 'Gui' },
];

const CHAT: string[] = [
  'oi Lia!',
  'boa noite, tudo bem?',
  'qual é o seu nome?',
  'amei a live',
  'de onde você é?',
  'quantos anos você tem?',
  'manda um presente',
  'curte a live, galera!',
  'que jogo é esse?',
  'segue eu?',
  'você é linda',
  'toca uma música',
  'oi',
  'oi',
  '!ajuda',
  'kkkkkk',
];

/** PRNG determinístico (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class SimulatedSource implements LiveSource {
  readonly name = 'simulator';

  private rng: () => number;
  private timer: NodeJS.Timeout | null = null;
  private readonly pending = new Set<NodeJS.Timeout>();
  private tick = 0;
  private seq = 0;
  private stopped = true;
  private userId = 'sim';

  constructor(private readonly options: SimulatedSourceOptions) {
    this.rng = mulberry32(options.seed ?? 42);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.status({ status: 'connecting' });
    this.status({ status: 'connected', room: 'sala-simulada' });
    this.options.logger.info(
      'Modo simulação: gerando eventos de teste (nenhuma conexão com o TikTok).',
    );

    const interval = Math.max(200, this.options.intervalMs ?? 1200);
    this.timer = setInterval(() => this.generate(), interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timeout of this.pending) clearTimeout(timeout);
    this.pending.clear();
    this.status({ status: 'disconnected' });
  }

  private generate(): void {
    if (this.stopped) return;
    this.tick += 1;

    if (this.tick % 5 === 0) {
      this.emit({ type: 'viewers', id: this.id(), ts: Date.now(), count: 20 + Math.floor(this.rng() * 400) });
    }

    const forcedExpensive =
      this.options.expensiveEvery !== undefined &&
      this.options.expensiveEvery > 0 &&
      this.tick % this.options.expensiveEvery === 0;

    if (forcedExpensive) {
      this.gift(this.pick(USERS), this.pick(GIFT_CATALOG.filter((g) => g.diamonds >= 500)), 4);
      return;
    }

    const roll = this.rng();

    if (roll < 0.5) this.chat();
    else if (roll < 0.68) this.gift(this.pick(USERS), this.pick(GIFT_CATALOG), undefined);
    else if (roll < 0.84) this.likes();
    else if (roll < 0.92) this.social('follow');
    else if (roll < 0.96) this.social('share');
    else if (roll < 0.98) this.social('subscribe');
    else this.social('join');
  }

  private chat(): void {
    const user = this.pick(USERS);
    const text = this.pick(CHAT);
    this.emit({ type: 'chat', id: this.id(), ts: Date.now(), user, text });
  }

  private likes(): void {
    const user = this.pick(USERS);
    const count = 3 + Math.floor(this.rng() * 40);
    this.emit({ type: 'like', id: this.id(), ts: Date.now(), user, count });
  }

  private social(type: SocialEvent['type']): void {
    this.emit({ type, id: this.id(), ts: Date.now(), user: this.pick(USERS) });
  }

  private gift(user: Viewer, item: GiftCatalogItem, forcedRepeat?: number): void {
    const streakable = item.diamonds >= 20;
    const repeat = forcedRepeat ?? (streakable ? 1 + Math.floor(this.rng() * 4) : 1);

    if (!streakable || repeat === 1) {
      this.emitGift(user, item, 1, true, streakable);
      return;
    }

    // Simula o combo: uma mensagem por unidade, com repeatEnd na última.
    const stepMs = 350;
    for (let i = 1; i <= repeat; i++) {
      const timeout = setTimeout(() => {
        this.pending.delete(timeout);
        if (this.stopped) return;
        this.emitGift(user, item, i, i === repeat, true);
      }, stepMs * (i - 1));
      this.pending.add(timeout);
    }
  }

  private emitGift(
    user: Viewer,
    item: GiftCatalogItem,
    repeatCount: number,
    comboEnd: boolean,
    streakable: boolean,
  ): void {
    const event: GiftEvent = {
      type: 'gift',
      id: this.id(),
      ts: Date.now(),
      user,
      giftId: item.id,
      giftName: item.name,
      diamonds: item.diamonds,
      repeatCount,
      comboEnd,
      streakable,
    };
    this.emit(event);
  }

  private emit(event: LiveEvent): void {
    if (this.stopped) return;
    this.options.onEvent(event);
  }

  private status(status: LiveSourceStatus): void {
    this.options.onStatus(status);
  }

  private pick<T>(items: T[]): T {
    const index = Math.min(items.length - 1, Math.floor(this.rng() * items.length));
    return items[index] as T;
  }

  private id(): string {
    return `${this.userId}-${++this.seq}`;
  }
}
