/**
 * Carregamento e validação de configuração.
 *
 * `config/game.json` pode ser editado por quem for montar o visual: os números
 * que importam (moedas por diamante, limite do presente caro, cooldowns, janela
 * do chat, animações) ficam todos lá. Campos ausentes caem no padrão.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const DonationTierSchema = z.object({
  id: z.string().min(1),
  minCoins: z.number().int().nonnegative(),
  animation: z.string().min(1),
  intensity: z.number().int().min(1).max(5).default(2),
});

export type DonationTier = z.infer<typeof DonationTierSchema>;

const DEFAULT_TIERS: DonationTier[] = [
  { id: 'bronze', minCoins: 1, animation: 'wave', intensity: 1 },
  { id: 'prata', minCoins: 100, animation: 'cheer', intensity: 2 },
  { id: 'ouro', minCoins: 500, animation: 'dance', intensity: 3 },
  { id: 'diamante', minCoins: 1000, animation: 'celebrate', intensity: 4 },
];

export const GameConfigSchema = z
  .object({
    room: z
      .object({
        /** @usuário da live; pode ser preenchido por TIKTOK_USERNAME. */
        uniqueId: z.string().default(''),
      })
      .prefault({}),

    coins: z
      .object({
        /**
         * Quantas moedas vale 1 diamante. O TikTok mostra o preço do presente
         * em moedas, mas envia o valor em diamantes; a conversão usual é 2.
         */
        perDiamond: z.number().positive().default(2),
        /** Sobrescreve o valor de um presente específico (por giftId). */
        overrides: z.record(z.string(), z.number().nonnegative()).default({}),
      })
      .prefault({}),

    donation: z
      .object({
        /** Faixas de doação, da mais barata para a mais cara. */
        tiers: z.array(DonationTierSchema).min(1).default(DEFAULT_TIERS),
        /**
         * A partir de quantas moedas o personagem também agradece em voz alta.
         * 0 desliga (presentes só disparam animação).
         */
        speakFromCoins: z.number().int().nonnegative().default(0),
        goal: z
          .object({
            enabled: z.boolean().default(true),
            targetCoins: z.number().positive().default(5000),
            animation: z.string().min(1).default('fireworks'),
            /** Se true, o personagem fala quando a meta é batida. */
            announce: z.boolean().default(true),
          })
          .prefault({}),
      })
      .prefault({}),

    expensiveGift: z
      .object({
        enabled: z.boolean().default(true),
        /** Estritamente maior que este valor em moedas (1000 → 1001+). */
        minCoinsExclusive: z.number().positive().default(1000),
        animation: z.string().min(1).default('bow'),
        intensity: z.number().int().min(1).max(5).default(5),
        /** Se true, o personagem responde nominalmente a quem mandou. */
        speak: z.boolean().default(true),
      })
      .prefault({}),

    likes: z
      .object({
        /** A cada N curtidas, dispara uma ação. */
        step: z.number().int().positive().default(100),
        animation: z.string().min(1).default('hype'),
        intensity: z.number().int().min(1).max(5).default(3),
        /** Teto de animações por mensagem (lotes enormes não viram spam). */
        maxMilestonesPerEvent: z.number().int().positive().default(5),
      })
      .prefault({}),

    chat: z
      .object({
        /** Janela deslizante de mensagens usada na garantia de resposta. */
        windowSize: z.number().int().positive().default(10),
        /** Mínimo de respostas por janela (4 de 10). */
        minRepliesPerWindow: z.number().int().nonnegative().default(4),
        /** Teto de respostas por janela, para não responder tudo. */
        maxRepliesPerWindow: z.number().int().positive().default(6),
        /** Intervalo mínimo entre duas respostas quaisquer. */
        cooldownMs: z.number().int().nonnegative().default(2500),
        /**
         * Piso de espaçamento mesmo quando a cota mínima está atrasada: evita
         * 4 balões em 1 segundo numa rajada de mensagens.
         */
        minReplyGapMs: z.number().int().nonnegative().default(800),
        /** Intervalo mínimo para responder a mesma pessoa de novo. */
        perUserCooldownMs: z.number().int().nonnegative().default(20_000),
        /** Piso absoluto entre respostas à mesma pessoa (mesmo furando a cota). */
        sameUserFloorMs: z.number().int().nonnegative().default(1200),
        /** Ignora mensagens repetidas da mesma pessoa nesse intervalo. */
        duplicateWindowMs: z.number().int().nonnegative().default(30_000),
        /** Fila máxima de mensagens aguardando resposta. */
        maxQueue: z.number().int().positive().default(30),
        /** Mensagens menores que isso são ignoradas. */
        minLength: z.number().int().nonnegative().default(2),
        /** Ignora comandos que começam com "!". */
        ignoreCommands: z.boolean().default(true),
      })
      .prefault({}),

    gifts: z
      .object({
        /** Tempo sem novos incrementos para considerar o combo encerrado. */
        comboFlushMs: z.number().int().nonnegative().default(1500),
      })
      .prefault({}),

    social: z
      .object({
        announceFollows: z.boolean().default(false),
        /** Entradas na live podem ser barulhentas; desligado por padrão. */
        announceJoins: z.boolean().default(false),
        followAnimation: z.string().min(1).default('wave'),
        shareAnimation: z.string().min(1).default('cheer'),
        subscribeAnimation: z.string().min(1).default('celebrate'),
        joinAnimation: z.string().min(1).default('idle'),
      })
      .prefault({}),

    overlay: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        /** 0 = porta efêmera (usado nos testes). */
        port: z.number().int().min(0).max(65_535).default(8787),
        /** Intervalo mínimo entre snapshots de estado no WebSocket. */
        stateThrottleMs: z.number().int().nonnegative().default(500),
      })
      .prefault({}),

    session: z
      .object({
        /** Retoma totais/ranking depois de reiniciar o processo. */
        persist: z.boolean().default(true),
        path: z.string().min(1).default('data/session.json'),
        saveDebounceMs: z.number().int().nonnegative().default(3000),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    const { chat } = config;

    if (chat.minRepliesPerWindow > chat.windowSize) {
      ctx.addIssue({
        code: 'custom',
        message: 'chat.minRepliesPerWindow não pode ser maior que chat.windowSize',
        path: ['chat', 'minRepliesPerWindow'],
      });
    }
    if (chat.maxRepliesPerWindow < chat.minRepliesPerWindow) {
      ctx.addIssue({
        code: 'custom',
        message: 'chat.maxRepliesPerWindow não pode ser menor que chat.minRepliesPerWindow',
        path: ['chat', 'maxRepliesPerWindow'],
      });
    }
    if (chat.maxRepliesPerWindow > chat.windowSize) {
      ctx.addIssue({
        code: 'custom',
        message: 'chat.maxRepliesPerWindow não pode ser maior que chat.windowSize',
        path: ['chat', 'maxRepliesPerWindow'],
      });
    }

    const tiers = config.donation.tiers;
    for (let i = 1; i < tiers.length; i++) {
      const previous = tiers[i - 1];
      const current = tiers[i];
      if (previous && current && current.minCoins <= previous.minCoins) {
        ctx.addIssue({
          code: 'custom',
          message: `donation.tiers precisa estar em ordem crescente de minCoins (${previous.id} → ${current.id})`,
          path: ['donation', 'tiers', i, 'minCoins'],
        });
      }
    }
  });

export type GameConfig = z.infer<typeof GameConfigSchema>;

export const LinesSchema = z.object({
  persona: z
    .object({
      name: z.string().min(1).default('Lia'),
      emoji: z.string().default('💜'),
    })
    .prefault({}),
  intents: z
    .array(
      z.object({
        id: z.string().min(1),
        patterns: z.array(z.string().min(1)).min(1),
        replies: z.array(z.string().min(1)).min(1),
      }),
    )
    .default([]),
  chatFallback: z
    .array(z.string().min(1))
    .min(1)
    .default(['Recebi seu recado, {name}!', 'Fala mais, {name}, que eu tô ouvindo!']),
  gift: z.record(z.string(), z.array(z.string().min(1))).default({}),
  expensiveGift: z
    .array(z.string().min(1))
    .min(1)
    .default(['{name}!!! {gift} de {coins} moedas?! Você é uma lenda! 👑']),
  follow: z.array(z.string().min(1)).default(['Bem-vindo(a), {name}!']),
  subscribe: z.array(z.string().min(1)).default(['Assinatura nova! Obrigada, {name}!']),
  goal: z.array(z.string().min(1)).default(['META BATIDA! {coins} moedas! 🎉']),
});

export type LinesConfig = z.infer<typeof LinesSchema>;

export interface LoadedConfig {
  config: GameConfig;
  lines: LinesConfig;
  configPath: string;
  linesPath: string;
}

export interface LoadConfigOptions {
  configPath?: string;
  linesPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function readJson(path: string): unknown {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `JSON inválido em ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
    .join('\n');
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath ?? env.GAME_CONFIG ?? 'config/game.json');
  const linesPath = resolve(
    cwd,
    options.linesPath ?? env.GAME_LINES ?? 'config/lines.pt-BR.json',
  );

  const rawConfig = readJson(configPath);
  const rawLines = readJson(linesPath);

  let config: GameConfig;
  try {
    config = GameConfigSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Configuração inválida (${configPath}):\n${formatIssues(error)}`);
    }
    throw error;
  }

  let lines: LinesConfig;
  try {
    lines = LinesSchema.parse(rawLines);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Falas inválidas (${linesPath}):\n${formatIssues(error)}`);
    }
    throw error;
  }

  // Variáveis de ambiente têm prioridade sobre o arquivo.
  if (env.TIKTOK_USERNAME) config.room.uniqueId = env.TIKTOK_USERNAME.replace(/^@/, '');
  if (env.HOST) config.overlay.host = env.HOST;
  if (env.PORT) {
    const port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`PORT inválida: ${env.PORT}`);
    }
    config.overlay.port = port;
  }

  return { config, lines, configPath, linesPath };
}
