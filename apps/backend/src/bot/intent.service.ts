import { Injectable, Logger } from '@nestjs/common';

export enum Intent {
  AGENDAR = 'agendar',
  REPROGRAMAR = 'reprogramar',
  CANCELAR = 'cancelar',
  CONFIRMAR = 'confirmar',
  PREGUNTA_FAQ = 'pregunta_faq',
  HABLAR_HUMANO = 'hablar_humano',
  OTRO = 'otro',
}

/**
 * Detección de intención con LLM barata (DeepSeek primario, Gemini fallback).
 * Reutiliza el patrón del router LLM de Blog Condor: fetch nativo, sin SDK.
 * Devuelve una de las intenciones del enum.
 */
@Injectable()
export class IntentService {
  private readonly logger = new Logger(IntentService.name);

  async detect(text: string, locale = 'es'): Promise<Intent> {
    const system =
      'Clasifica el mensaje del paciente de una clínica en UNA de estas categorías ' +
      'y responde SOLO con la palabra exacta: agendar, reprogramar, cancelar, ' +
      'confirmar, pregunta_faq, hablar_humano, otro.';

    try {
      const raw = await this.callDeepSeek(system, text);
      return this.parse(raw);
    } catch (e) {
      this.logger.warn(`DeepSeek falló, intento Gemini: ${e}`);
      try {
        const raw = await this.callGemini(system, text);
        return this.parse(raw);
      } catch (e2) {
        this.logger.error(`Ambos LLM fallaron: ${e2}`);
        return Intent.OTRO;
      }
    }
  }

  private parse(raw: string): Intent {
    const v = raw.trim().toLowerCase();
    const found = Object.values(Intent).find((i) => v.includes(i));
    return (found as Intent) ?? Intent.OTRO;
  }

  private async callDeepSeek(system: string, user: string): Promise<string> {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY missing');
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 5,
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}`);
    const data = (await res.json()) as any;
    return data.choices?.[0]?.message?.content ?? '';
  }

  private async callGemini(system: string, user: string): Promise<string> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY missing');
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\nMensaje: ${user}` }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 5 },
        }),
      },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const data = (await res.json()) as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
}
