/**
 * Portão de fala para eventos "de fundo" (entrada, curtida, doação pequena).
 *
 * Sem isso, uma live movimentada viraria um personagem falando sem parar:
 * cada entrada e cada lote de curtidas dispararia um comentário. O portão
 * combina chance, cooldown global, cooldown por pessoa e teto por minuto.
 */
import type { Clock } from '../clock.js';
import type { CommentGateConfig } from '../config.js';

export class CommentGate {
  private lastGlobal = Number.NEGATIVE_INFINITY;
  private readonly lastByUser = new Map<string, number>();
  private recent: number[] = [];
  private readonly rng: () => number;

  constructor(
    private readonly options: CommentGateConfig,
    private readonly clock: Clock,
    rng?: () => number,
  ) {
    this.rng = rng ?? Math.random;
  }

  /** Retorna true e consome a "vaga" quando o comentário deve acontecer. */
  take(userId: string): boolean {
    if (!this.options.enabled) return false;

    const now = this.clock.now();
    if (now - this.lastGlobal < this.options.cooldownMs) return false;

    if (this.options.perUserCooldownMs > 0) {
      const last = this.lastByUser.get(userId);
      if (last !== undefined && now - last < this.options.perUserCooldownMs) return false;
    }

    this.prune(now);
    if (this.recent.length >= this.options.maxPerMinute) return false;
    if (this.rng() >= this.options.chance) return false;

    this.lastGlobal = now;
    this.lastByUser.set(userId, now);
    if (this.lastByUser.size > 1_000) {
      for (const [key, at] of this.lastByUser) {
        if (now - at > this.options.perUserCooldownMs) this.lastByUser.delete(key);
      }
    }
    this.recent.push(now);
    return true;
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.recent.length > 0 && (this.recent[0] ?? 0) <= cutoff) {
      this.recent.shift();
    }
  }
}
