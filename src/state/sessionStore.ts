/**
 * Persistência simples da sessão (totais, ranking, marco de curtidas, meta).
 *
 * Grava em `data/session.json` com debounce e escrita atômica (arquivo
 * temporário + rename), para um restart no meio da live não perder a contagem
 * de moedas nem o ranking.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import type { PersistedSession } from '../engine/gameEngine.js';

export class SessionStore {
  private readonly absolutePath: string;
  private timer: unknown = null;
  private pending: (() => PersistedSession) | null = null;

  constructor(
    path: string,
    private readonly clock: Clock,
    private readonly debounceMs: number,
    private readonly logger: Logger,
  ) {
    this.absolutePath = resolve(process.cwd(), path);
  }

  load(): PersistedSession | null {
    try {
      const raw = JSON.parse(readFileSync(this.absolutePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return null;
      const session = raw as PersistedSession;
      if (session.version !== 1 || typeof session.totals !== 'object') return null;
      return session;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(
          `Não foi possível ler ${this.absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }

  /** Agenda uma gravação; chamadas seguidas só gravam uma vez. */
  scheduleSave(getSnapshot: () => PersistedSession): void {
    this.pending = getSnapshot;
    if (this.timer !== null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.save();
    }, this.debounceMs);
  }

  /** Grava agora (usado no desligamento). */
  flush(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }

  private save(): void {
    const snapshot = this.pending?.();
    this.pending = null;
    if (!snapshot) return;

    try {
      mkdirSync(dirname(this.absolutePath), { recursive: true });
      const temp = `${this.absolutePath}.tmp`;
      writeFileSync(temp, JSON.stringify(snapshot, null, 2), 'utf8');
      renameSync(temp, this.absolutePath);
    } catch (error) {
      this.logger.warn(
        `Falha ao salvar sessão: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
