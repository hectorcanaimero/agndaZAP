import { Injectable, Logger } from '@nestjs/common';
import { LlmRouterService } from '../common/llm/llm-router.service';

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
 * Clasifica intención con LLM barato vía `LlmRouterService`. Si todos los
 * providers fallan, degrada a `Intent.OTRO` (el bot responde el flujo genérico
 * "no te entendí" en vez de romper el webhook).
 */
@Injectable()
export class IntentService {
  private readonly logger = new Logger(IntentService.name);

  constructor(private readonly llm: LlmRouterService) {}

  async detect(text: string, _locale = 'es'): Promise<Intent> {
    const deterministic = this.detectDeterministic(text);
    if (deterministic) return deterministic;

    const system =
      'Clasifica el mensaje del paciente de una clínica en UNA de estas categorías ' +
      'y responde SOLO con la palabra exacta: agendar, reprogramar, cancelar, ' +
      'confirmar, pregunta_faq, hablar_humano, otro.';
    try {
      const raw = await this.llm.complete({ system, user: text, maxTokens: 5 });
      return this.parse(raw);
    } catch (e) {
      this.logger.error(`intent detect: todos los LLM fallaron: ${e}`);
      return Intent.OTRO;
    }
  }

  private parse(raw: string): Intent {
    const v = raw.trim().toLowerCase();
    const found = Object.values(Intent).find((i) => v.includes(i));
    return (found as Intent) ?? Intent.OTRO;
  }

  private detectDeterministic(text: string): Intent | null {
    const normalized = text
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[¡!¿?.,;:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) return null;
    if (
      this.startsWithAny(normalized, [
        'si',
        'confirmo',
        'confirmar',
        'ok',
        'dale',
      ])
    ) {
      return Intent.CONFIRMAR;
    }
    if (
      this.startsWithAny(normalized, [
        'cancelar',
        'cancela',
        'cancelo',
        'anular',
      ])
    ) {
      return Intent.CANCELAR;
    }
    if (this.startsWithAny(normalized, ['reagendar', 'reprogramar'])) {
      return Intent.REPROGRAMAR;
    }
    if (this.startsWithAny(normalized, ['agendar', 'reservar', 'sacar turno'])) {
      return Intent.AGENDAR;
    }
    if (
      normalized.includes('hablar con') ||
      this.startsWithAny(normalized, [
        'humano',
        'persona',
        'operador',
        'asesor',
        'representante',
      ])
    ) {
      return Intent.HABLAR_HUMANO;
    }
    return null;
  }

  private startsWithAny(normalized: string, keywords: string[]): boolean {
    return keywords.some((keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escaped}(?:\\b|$)`, 'u').test(normalized);
    });
  }
}
