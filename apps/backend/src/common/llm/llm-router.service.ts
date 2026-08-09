import { Injectable, Logger } from '@nestjs/common';

export interface LlmCompletionOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Timeout por provider (ms). Default 3000 — WAHA reintenta si el webhook tarda. */
  timeoutMs?: number;
}

const PROVIDER_NAMES = ['deepseek', 'opencode', 'gemini'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const DEFAULT_ORDER: ProviderName[] = ['deepseek', 'opencode', 'gemini'];
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_TOKENS = 200;

/**
 * Router unificado para chat completions. Recorre providers en orden y hace
 * fallback en cadena. Un provider sin API key se saltea silenciosamente
 * (permite deploys parciales sin romper el flujo).
 *
 * Providers:
 *  - `deepseek` — DeepSeek Chat (OpenAI-compat, endpoint fijo).
 *  - `opencode` — Gateway OpenAI-compat vía `OPENCODE_BASE_URL`/`OPENCODE_PLAN`.
 *  - `gemini`   — Google `gemini-2.0-flash` (shape distinto).
 *
 * Orden configurable por `LLM_PROVIDER_ORDER` (csv). Default:
 * `deepseek,opencode,gemini`.
 *
 * NO cubre embeddings — `KnowledgeService.embedText` sigue llamando a OpenAI
 * directamente (dimensión y modelo distintos, no aplica el patrón de fallback).
 */
@Injectable()
export class LlmRouterService {
  private readonly logger = new Logger(LlmRouterService.name);

  async complete(opts: LlmCompletionOptions): Promise<string> {
    const order = this.resolveOrder();
    const errors: string[] = [];

    for (const provider of order) {
      try {
        const result = await this.callProvider(provider, opts);
        if (errors.length > 0) {
          this.logger.warn(
            `llm fallback ok: ${provider} respondió tras fallos previos [${errors.join(', ')}]`,
          );
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${provider}:${msg}`);
      }
    }
    throw new Error(`todos los LLM fallaron: ${errors.join(' | ')}`);
  }

  private resolveOrder(): ProviderName[] {
    const raw = process.env.LLM_PROVIDER_ORDER;
    if (!raw) return DEFAULT_ORDER;
    const parsed = raw
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter((p): p is ProviderName =>
        (PROVIDER_NAMES as readonly string[]).includes(p),
      );
    return parsed.length > 0 ? parsed : DEFAULT_ORDER;
  }

  private callProvider(
    provider: ProviderName,
    opts: LlmCompletionOptions,
  ): Promise<string> {
    switch (provider) {
      case 'deepseek':
        return this.callDeepSeek(opts);
      case 'opencode':
        return this.callOpenCode(opts);
      case 'gemini':
        return this.callGemini(opts);
    }
  }

  private callDeepSeek(opts: LlmCompletionOptions): Promise<string> {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY missing');
    return this.callOpenAICompat({
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: key,
      model: 'deepseek-chat',
      opts,
    });
  }

  private callOpenCode(opts: LlmCompletionOptions): Promise<string> {
    const key = process.env.OPENCODE_API_KEY;
    const baseUrl = process.env.OPENCODE_BASE_URL;
    const plan = process.env.OPENCODE_PLAN;
    if (!key) throw new Error('OPENCODE_API_KEY missing');
    if (!baseUrl) throw new Error('OPENCODE_BASE_URL missing');
    if (!plan) throw new Error('OPENCODE_PLAN missing');
    // Normalizamos: acepta base URL con/sin trailing slash y con/sin `/chat/completions`.
    const trimmed = baseUrl.replace(/\/+$/, '');
    const url = trimmed.endsWith('/chat/completions')
      ? trimmed
      : `${trimmed}/chat/completions`;
    return this.callOpenAICompat({ url, apiKey: key, model: plan, opts });
  }

  private async callOpenAICompat(args: {
    url: string;
    apiKey: string;
    model: string;
    opts: LlmCompletionOptions;
  }): Promise<string> {
    const { url, apiKey, model, opts } = args;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
          temperature: opts.temperature ?? 0,
          max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('empty content');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  private async callGemini(opts: LlmCompletionOptions): Promise<string> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY missing');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${opts.system}\n\n${opts.user}` }] }],
            generationConfig: {
              temperature: opts.temperature ?? 0,
              maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            },
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) throw new Error(`http ${res.status}`);
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error('empty content');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
