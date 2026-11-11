/** Logger minimalista, com escopo e nível configurável por env (LOG_LEVEL). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? 'info').toLowerCase();
  if (normalized in LEVEL_WEIGHT) return normalized as LogLevel;
  return 'info';
}

export function createLogger(level: LogLevel = 'info', scope?: string): Logger {
  const min = LEVEL_WEIGHT[level];
  const prefix = scope ? `[${scope}]` : '';

  const write = (
    target: Exclude<LogLevel, 'silent'>,
    message: string,
    extra?: unknown,
  ): void => {
    if (LEVEL_WEIGHT[target] < min) return;
    const line = `${new Date().toISOString()} ${target.toUpperCase().padEnd(5)} ${prefix} ${message}`;
    const args: unknown[] = extra === undefined ? [line] : [line, extra];
    if (target === 'error' || target === 'warn') console.error(...args);
    else console.log(...args);
  };

  return {
    debug: (message, extra) => write('debug', message, extra),
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    child: (childScope) =>
      createLogger(level, scope ? `${scope}:${childScope}` : childScope),
  };
}
