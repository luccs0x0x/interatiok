/**
 * Relógio injetável.
 *
 * O motor nunca chama `Date.now()`/`setTimeout` direto: nos testes usamos um
 * relógio falso para simular cooldowns, combos e janelas de 10 mensagens sem
 * esperar em tempo real.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): unknown {
    return setTimeout(fn, ms);
  }

  clearTimeout(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

interface FakeTimer {
  at: number;
  fn: () => void;
  seq: number;
}

/**
 * Relógio determinístico para testes.
 *
 * `advance()` executa os timers vencidos em ordem cronológica, incluindo os que
 * forem agendados durante a execução, e drena as microtasks entre eles para que
 * respostas assíncronas do personagem cheguem na ordem esperada.
 */
export class FakeClock implements Clock {
  private current: number;
  private nextHandle = 1;
  private nextSeq = 0;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, {
      at: this.current + Math.max(0, ms),
      fn,
      seq: this.nextSeq++,
    });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  /** Quantidade de timers pendentes (útil para asserts). */
  pendingTimers(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + Math.max(0, ms);
    let guard = 0;

    for (;;) {
      if (guard++ > 10_000) {
        throw new Error('FakeClock: timers demais executados (loop infinito?)');
      }

      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq)[0];

      if (!due) break;

      const [handle, timer] = due;
      this.timers.delete(handle);
      this.current = timer.at;
      timer.fn();
      await flushMicrotasks();
    }

    this.current = target;
    await flushMicrotasks();
  }

  /** Avança até o próximo timer agendado (ou não faz nada). */
  async advanceToNextTimer(): Promise<void> {
    const next = [...this.timers.values()].sort(
      (a, b) => a.at - b.at || a.seq - b.seq,
    )[0];
    if (!next) return;
    await this.advance(Math.max(0, next.at - this.current));
  }
}

export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
