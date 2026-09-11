import { Injectable, Logger } from '@nestjs/common';
import { LlmRouterService } from '../common/llm/llm-router.service';
import {
  countTokens,
  isCourtesyClosing,
  isHumanEscape,
  normalizeText,
  startsWithAny,
} from './message-matching';

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
 *
 * Las reglas deterministas comparten el matching con `BotService` (ver
 * `message-matching.ts`) para que el clasificador y la escalera del bot no se
 * contradigan.
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
    const normalized = normalizeText(text);
    if (!normalized) return null;

    // "ok gracias" es un cierre de cortesía, no una confirmación. Se chequea
    // ANTES que `ok`/`dale` para que cualquier consumidor de `detect()` —no
    // solo `BotService`, que lo intercepta antes— no lo lea como CONFIRMAR.
    if (isCourtesyClosing(normalized)) return Intent.OTRO;

    // `confirmo` / `confirmar` son verbos explícitos: valen siempre.
    // `si` / `ok` / `dale` son ambiguos — solo cuentan como confirmación si el
    // mensaje es corto. "sí, quiero agendar una cita" NO es una confirmación,
    // es un pedido de turno que empieza con "sí" (ver B2 del análisis del bot).
    if (
      startsWithAny(normalized, ['confirmo', 'confirmar']) ||
      (countTokens(normalized) <= 2 &&
        startsWithAny(normalized, ['si', 'ok', 'dale']))
    ) {
      return Intent.CONFIRMAR;
    }
    if (startsWithAny(normalized, ['cancelar', 'cancela', 'cancelo', 'anular'])) {
      return Intent.CANCELAR;
    }
    if (startsWithAny(normalized, ['reagendar', 'reprogramar'])) {
      return Intent.REPROGRAMAR;
    }
    if (startsWithAny(normalized, ['agendar', 'reservar', 'sacar turno'])) {
      return Intent.AGENDAR;
    }
    // `persona` suelta NO deriva (B3): "es para otra persona" es un mensaje
    // normal. Ver `isHumanEscape` en message-matching.ts.
    if (isHumanEscape(normalized)) {
      return Intent.HABLAR_HUMANO;
    }
    return null;
  }
}
