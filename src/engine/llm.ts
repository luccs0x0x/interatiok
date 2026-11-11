/**
 * Cliente opcional para um endpoint compatível com a API de Chat Completions
 * (OpenAI, Groq, Together, Ollama, LM Studio, etc.).
 *
 * Sem `LLM_API_KEY` configurada, o personagem usa apenas as falas de
 * `config/lines.pt-BR.json` — o jogo funciona 100% offline.
 */
import type { Logger } from '../logger.js';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: (env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey,
    model: env.LLM_MODEL ?? 'gpt-4o-mini',
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 2500),
  };
}

export class LlmClient {
  private failedOnce = false;

  constructor(
    private readonly config: LlmConfig,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return true;
  }

  /**
   * Retorna o texto gerado ou `null` em qualquer falha (timeout, HTTP, formato).
   * O chamador deve ter um fallback por template.
   */
  async complete(system: string, user: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.9,
          max_tokens: 80,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return null;

      const cleaned = sanitize(content);
      if (!cleaned) return null;

      this.failedOnce = false;
      return cleaned;
    } catch (error) {
      if (!this.failedOnce) {
        this.failedOnce = true;
        this.logger.warn(
          `LLM indisponível, usando falas locais: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
}

const MAX_CHARS = 180;

export function sanitize(text: string): string {
  const withoutMd = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!withoutMd) return '';
  if (/\b(como (uma )?ia|modelo de linguagem|assistente virtual)\b/i.test(withoutMd)) {
    return '';
  }

  return withoutMd.length > MAX_CHARS
    ? `${withoutMd.slice(0, MAX_CHARS - 1).trimEnd()}…`
    : withoutMd;
}
