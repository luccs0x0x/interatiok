/**
 * Junta os incrementos de um presente de combo em um único evento.
 *
 * O TikTok manda uma mensagem por "tapa" do combo (repeatCount 1, 2, 3...).
 * Se o motor reagisse a cada uma, um presente de 10 unidades viraria 10
 * animações e 10 agradecimentos. Aqui esperamos o fim do combo (repeatEnd) ou
 * um tempo sem novos incrementos e emitimos o total de uma vez.
 */
import type { Clock } from '../clock.js';
import type { GiftEvent, Viewer } from '../types.js';

export interface CombinedGift {
  user: Viewer;
  giftId: string;
  giftName: string;
  iconUrl?: string;
  /** Valor unitário em diamantes. */
  diamonds: number;
  /** Total de unidades do combo (>= 1). */
  repeatCount: number;
  ts: number;
}

interface ComboState {
  gift: GiftEvent;
  repeat: number;
  timer: unknown;
}

export class GiftCombiner {
  private readonly combos = new Map<string, ComboState>();

  constructor(
    private readonly clock: Clock,
    private readonly flushMs: number,
    private readonly onFlush: (gift: CombinedGift) => void,
  ) {}

  push(event: GiftEvent): void {
    const repeat = Math.max(1, event.repeatCount);

    if (!event.streakable) {
      this.emit(event, repeat);
      return;
    }

    const key = `${event.user.userId}:${event.giftId}`;
    const existing = this.combos.get(key);

    if (existing) this.clock.clearTimeout(existing.timer);

    const state: ComboState = {
      gift: event,
      repeat: Math.max(existing?.repeat ?? 0, repeat),
      timer: null,
    };

    if (event.comboEnd) {
      this.combos.delete(key);
      this.emit(state.gift, state.repeat);
      return;
    }

    state.timer = this.clock.setTimeout(() => {
      this.combos.delete(key);
      this.emit(state.gift, state.repeat);
    }, this.flushMs);

    this.combos.set(key, state);
  }

  /** Emite todos os combos abertos (usado no desligamento). */
  flushAll(): void {
    const pending = [...this.combos.entries()];
    this.combos.clear();
    for (const [, state] of pending) {
      this.clock.clearTimeout(state.timer);
      this.emit(state.gift, state.repeat);
    }
  }

  dispose(): void {
    for (const [, state] of this.combos) this.clock.clearTimeout(state.timer);
    this.combos.clear();
  }

  private emit(gift: GiftEvent, repeatCount: number): void {
    this.onFlush({
      user: gift.user,
      giftId: gift.giftId,
      giftName: gift.giftName,
      ...(gift.iconUrl ? { iconUrl: gift.iconUrl } : {}),
      diamonds: gift.diamonds,
      repeatCount,
      ts: this.clock.now(),
    });
  }
}
