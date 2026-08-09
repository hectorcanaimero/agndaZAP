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
}
