/**
 * "Cérebro" do personagem.
 *
 * Gera falas curtas em pt-BR a partir de `config/lines.pt-BR.json` e, se houver
 * um LLM configurado, tenta uma resposta mais natural primeiro — sempre com
 * fallback local e limite de tempo, para a live nunca travar.
 */
import type { LinesConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Emotion, SocialKind, Viewer } from '../types.js';
import { LlmClient, sanitize } from './llm.js';

export interface SayContent {
  text: string;
  emotion: Emotion;
  /** Identificador do intent detectado ("gift", "greeting", "fallback"...). */
  intent: string;
}

export interface ChatContext {
  user: Viewer;
  text: string;
  coins: number;
  /** Últimas mensagens do chat, para dar contexto ao LLM. */
  history?: string[];
}

export interface GiftContext {
  user: Viewer;
  giftName: string;
  coins: number;
  tier: string;
  repeat: number;
}

export interface GoalContext {
  coins: number;
  target: number;
}

interface Intent {
  id: string;
  regexes: RegExp[];
  replies: string[];
}

export interface ResponderOptions {
  llm?: LlmClient | null;
  /** Fonte de aleatoriedade injetável (testes usam uma sequência fixa). */
  rng?: () => number;
  logger?: Logger;
}

const EMOTION_BY_INTENT: Record<string, Emotion> = {
  name: 'playful',
  age: 'playful',
  where: 'neutral',
  thanks: 'grateful',
  greeting: 'happy',
  music: 'excited',
  game: 'excited',
  follow: 'happy',
  love: 'shy',
  question: 'playful',
};

const MAX_NAME = 22;

export class CharacterResponder {
  private readonly rng: () => number;
  private readonly intents: Intent[];
  private readonly lastByCategory = new Map<string, string>();

  constructor(
    private readonly lines: LinesConfig,
    private readonly options: ResponderOptions = {},
  ) {
    this.rng = options.rng ?? Math.random;
    this.intents = lines.intents.map((intent) => ({
      id: intent.id,
      replies: intent.replies,
      regexes: intent.patterns.flatMap((pattern) => {
        try {
          return [new RegExp(pattern, 'iu')];
        } catch (error) {
          options.logger?.warn(
            `Regex inválido no intent "${intent.id}": ${pattern} (${String(error)})`,
          );
          return [];
        }
      }),
    }));
  }

  get personaName(): string {
    return this.lines.persona.name;
  }

  /** Resposta a uma mensagem de chat. */
  async answerChat(context: ChatContext): Promise<SayContent> {
    const intent = this.detect(context.text);

    if (this.options.llm) {
      const generated = await this.options.llm.complete(
        this.systemPrompt(),
        this.chatPrompt(context),
      );
      if (generated) {
        return {
          text: generated,
          emotion: intent ? (EMOTION_BY_INTENT[intent.id] ?? 'happy') : 'happy',
          intent: intent?.id ?? 'llm',
        };
      }
    }

    const replies = intent?.replies ?? this.lines.chatFallback;
    return {
      text: this.pick(`chat:${intent?.id ?? 'fallback'}`, replies, this.vars(context.user, {
        coins: context.coins,
      })),
      emotion: intent ? (EMOTION_BY_INTENT[intent.id] ?? 'happy') : 'happy',
      intent: intent?.id ?? 'fallback',
    };
  }

  /** Agradecimento por qualquer presente (a ação de doação). */
  thankGift(context: GiftContext): SayContent {
    const byTier = this.lines.gift[context.tier] ?? this.lines.gift.default ?? this.lines.chatFallback;
    return {
      text: this.pick(`gift:${context.tier}`, byTier, this.vars(context.user, {
        gift: context.giftName,
        coins: context.coins,
        tier: context.tier,
        repeat: context.repeat,
      })),
      emotion: context.tier === 'diamante' || context.tier === 'ouro' ? 'excited' : 'grateful',
      intent: 'gift',
    };
  }

  /** Resposta nominal a um presente acima do limite configurado. */
  async expensiveGift(context: GiftContext): Promise<SayContent> {
    if (this.options.llm) {
      const generated = await this.options.llm.complete(
        this.systemPrompt(),
        `@${context.user.username} (${context.user.nickname}) acabou de mandar o presente "${context.giftName}" que vale ${context.coins} moedas. Agradeça de forma efusiva, citando o nome da pessoa e o presente, em uma frase curta.`,
      );
      if (generated) {
        return { text: generated, emotion: 'surprised', intent: 'expensive_gift' };
      }
    }

    return {
      text: this.pick('gift:expensive', this.lines.expensiveGift, this.vars(context.user, {
        gift: context.giftName,
        coins: context.coins,
        tier: context.tier,
      })),
      emotion: 'surprised',
      intent: 'expensive_gift',
    };
  }

  /** Boas-vindas para follow/assinatura. */
  welcomeSocial(kind: SocialKind, user: Viewer, coins: number): SayContent {
    const replies =
      kind === 'subscribe'
        ? this.lines.subscribe
        : kind === 'follow'
          ? this.lines.follow
          : this.lines.chatFallback;

    return {
      text: this.pick(`social:${kind}`, replies, this.vars(user, { coins })),
      emotion: kind === 'share' ? 'excited' : 'happy',
      intent: kind,
    };
  }

  celebrateGoal(context: GoalContext): SayContent {
    return {
      text: this.pick('goal', this.lines.goal, {
        persona: this.lines.persona.name,
        emoji: this.lines.persona.emoji,
        coins: context.coins,
        target: context.target,
      }),
      emotion: 'excited',
      intent: 'goal',
    };
  }

  private detect(text: string): Intent | null {
    const normalized = text.trim();
    for (const intent of this.intents) {
      if (intent.regexes.some((regex) => regex.test(normalized))) return intent;
    }
    return null;
  }

  private vars(user: Viewer, extra: Record<string, string | number> = {}): Record<string, string | number> {
    const name = (user.nickname || user.username || 'amigo(a)').slice(0, MAX_NAME);
    return {
      name,
      username: user.username,
      persona: this.lines.persona.name,
      emoji: this.lines.persona.emoji,
      ...extra,
    };
  }

  /** Escolhe uma fala evitando repetir a última da mesma categoria. */
  private pick(
    category: string,
    templates: string[],
    vars: Record<string, string | number>,
  ): string {
    const last = this.lastByCategory.get(category);
    const available = templates.length > 1 ? templates.filter((t) => t !== last) : templates;
    const pool = available.length > 0 ? available : templates;
    const index = Math.min(pool.length - 1, Math.floor(this.rng() * pool.length));
    const template = pool[index] ?? pool[0] ?? '';
    this.lastByCategory.set(category, template);
    return render(template, vars);
  }

  private systemPrompt(): string {
    const persona = this.lines.persona;
    return [
      `Você é ${persona.name}, personagem de uma live de jogos no TikTok.`,
      'Fale em português brasileiro, com tom divertido, carinhoso e direto.',
      'Responda em no máximo 140 caracteres, em uma única frase, sem markdown.',
      'Cite o nome da pessoa quando fizer sentido.',
      'Nunca diga que é uma IA, nunca peça dados pessoais e nunca prometa dinheiro ou prêmios.',
    ].join(' ');
  }

  private chatPrompt(context: ChatContext): string {
    const history = (context.history ?? []).slice(-5).join('\n');
    const parts = [
      `Espectador @${context.user.username} (nome: ${context.user.nickname}) mandou no chat: "${context.text}"`,
    ];
    if (history) parts.push(`Últimas mensagens do chat:\n${history}`);
    return parts.join('\n\n');
  }
}

/** Substitui {nome}, {gift}, {coins}... mantendo placeholders desconhecidos. */
export function render(template: string, vars: Record<string, string | number>): string {
  const text = template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
  return sanitize(text) || text;
}
