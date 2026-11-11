#!/usr/bin/env node
/**
 * Ponto de entrada.
 *
 *   npm run simulate                 # eventos falsos, sem TikTok
 *   npm start -- --room=@usuario     # live real
 *   npm start -- --simulate --duration=15
 */
import { RealClock } from './clock.js';
import { loadConfig } from './config.js';
import { GameEngine } from './engine/gameEngine.js';
import { LlmClient, llmConfigFromEnv } from './engine/llm.js';
import { CharacterResponder } from './engine/responder.js';
import { SimulatedSource } from './live/simulatedSource.js';
import type { LiveSource, LiveSourceStatus } from './live/liveSource.js';
import { TikTokSource } from './live/tiktokSource.js';
import { createLogger, parseLogLevel } from './logger.js';
import { GameServer } from './server/server.js';
import { SessionStore } from './state/sessionStore.js';

interface CliOptions {
  simulate: boolean;
  room: string | null;
  port: number | null;
  durationSeconds: number | null;
  noPersist: boolean;
  help: boolean;
}

const USAGE = `
Uso: npm start -- [opções]

  --simulate            gera eventos falsos (não conecta no TikTok)
  --room=@usuario       live a acompanhar (ou TIKTOK_USERNAME)
  --port=8787           porta do overlay/WebSocket (ou PORT)
  --duration=30         encerra depois de N segundos (útil para testes)
  --no-persist          não grava data/session.json
  --help                mostra esta ajuda

Variáveis de ambiente principais:
  TIKTOK_USERNAME, TIKTOK_SIGN_API_KEY, TIKTOK_SESSIONID, TIKTOK_TT_TARGET_IDC
  LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
  SIM_TOKEN (protege POST /api/simulate quando o servidor não é local)
`.trim();

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    simulate: false,
    room: null,
    port: null,
    durationSeconds: null,
    noPersist: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--simulate' || arg === '--sim') options.simulate = true;
    else if (arg === '--no-persist') options.noPersist = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--room=')) options.room = arg.slice('--room='.length);
    else if (arg === '--room') options.room = argv[++i] ?? null;
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--port') options.port = Number(argv[++i] ?? '');
    else if (arg.startsWith('--duration=')) options.durationSeconds = Number(arg.slice('--duration='.length));
    else if (arg === '--duration') options.durationSeconds = Number(argv[++i] ?? '');
  }

  return options;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  try {
    process.loadEnvFile?.('.env');
  } catch {
    // .env é opcional.
  }

  const logger = createLogger(parseLogLevel(process.env.LOG_LEVEL), 'game');
  const { config, lines } = loadConfig();

  if (args.room) config.room.uniqueId = args.room.replace(/^@/, '');
  if (args.port !== null && Number.isInteger(args.port)) config.overlay.port = args.port;
  if (args.noPersist) config.session.persist = false;

  const clock = new RealClock();
  const llmConfig = llmConfigFromEnv();
  const responder = new CharacterResponder(lines, {
    llm: llmConfig ? new LlmClient(llmConfig, logger.child('llm')) : null,
    logger: logger.child('responder'),
  });

  const store =
    config.session.persist && !args.simulate
      ? new SessionStore(
          config.session.path,
          clock,
          config.session.saveDebounceMs,
          logger.child('session'),
        )
      : null;

  const session = store?.load() ?? null;
  if (session) {
    logger.info(
      `Sessão restaurada: ${session.totals.coins} moedas, ${session.totals.gifts} presentes.`,
    );
  }

  const engine = new GameEngine({
    config,
    lines,
    clock,
    responder,
    logger: logger.child('engine'),
    onAction: (action) => server.broadcastAction(action),
    onState: (state) => {
      server.broadcastState(state);
      store?.scheduleSave(() => engine.snapshot());
    },
    session,
  });

  const server = new GameServer({
    engine,
    config,
    logger: logger.child('server'),
    ...(process.env.SIM_TOKEN ? { simToken: process.env.SIM_TOKEN } : {}),
  });

  const address = await server.listen();
  logger.info(`HTTP/overlay: ${address.httpUrl}`);
  logger.info(`WebSocket:    ${address.wsUrl}`);

  const source = createSource(args, config.room.uniqueId, engine, logger);
  await source.start();

  const chat = config.chat;
  logger.info(
    `Regras ativas: ${chat.minRepliesPerWindow}/${chat.windowSize} respostas no chat ` +
      `(cooldown ${chat.cooldownMs}ms), marco de ${config.likes.step} curtidas, ` +
      `presente caro > ${config.expensiveGift.minCoinsExclusive} moedas, ` +
      `meta ${config.donation.goal.enabled ? config.donation.goal.targetCoins + ' moedas' : 'desligada'}.`,
  );

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Encerrando…');
    try {
      await source.stop();
    } catch (error) {
      logger.warn(`Falha ao parar a fonte: ${String(error)}`);
    }
    engine.dispose();
    store?.flush();
    try {
      await server.close();
    } catch {
      // ignore
    }
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Promise rejeitada sem tratamento: ${String(reason)}`);
  });

  if (args.durationSeconds && args.durationSeconds > 0) {
    const timer = setTimeout(() => void shutdown(0), args.durationSeconds * 1000);
    timer.unref?.();
  }
}

function createSource(
  args: CliOptions,
  room: string,
  engine: GameEngine,
  logger: ReturnType<typeof createLogger>,
): LiveSource {
  const onEvent = (event: Parameters<GameEngine['ingest']>[0]): void => engine.ingest(event);
  const onStatus = (status: LiveSourceStatus): void => {
    engine.setConnection(status.status, {
      room: status.room ?? null,
      message: status.message ?? null,
    });
    const label = `Conexão: ${status.status}${status.message ? ` (${status.message})` : ''}`;
    if (status.status === 'error') logger.error(label);
    else logger.info(label);
  };

  if (args.simulate) {
    return new SimulatedSource({
      intervalMs: numberFromEnv(process.env.SIM_INTERVAL_MS, 1200),
      seed: numberFromEnv(process.env.SIM_SEED, 42),
      expensiveEvery: numberFromEnv(process.env.SIM_EXPENSIVE_EVERY, 25),
      onEvent,
      onStatus,
      logger: logger.child('sim'),
    });
  }

  const uniqueId = room.replace(/^@/, '').trim();
  if (!uniqueId) {
    throw new Error(
      'Informe a live com --room=@usuario (ou TIKTOK_USERNAME) — ou rode com --simulate.',
    );
  }

  return new TikTokSource({
    uniqueId,
    ...(process.env.TIKTOK_SIGN_API_KEY ? { signApiKey: process.env.TIKTOK_SIGN_API_KEY } : {}),
    ...(process.env.TIKTOK_SESSIONID ? { sessionId: process.env.TIKTOK_SESSIONID } : {}),
    ...(process.env.TIKTOK_TT_TARGET_IDC
      ? { ttTargetIdc: process.env.TIKTOK_TT_TARGET_IDC }
      : {}),
    fetchGiftInfo: process.env.TIKTOK_FETCH_GIFT_INFO !== 'false',
    onEvent,
    onStatus,
    logger: logger.child('tiktok'),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
