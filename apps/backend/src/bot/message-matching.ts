/**
 * Capa de matching de texto del bot: funciones puras, sin DI ni DB.
 *
 * Vive fuera de `bot.service.ts` a propósito:
 *  - son reglas deterministas que conviene testear solas, sin montar la FSM;
 *  - las comparten `BotService` e `IntentService`, así que la escalera del bot
 *    y el clasificador determinista no pueden divergir.
 *
 * Todo lo que reciba un `normalized` espera texto ya pasado por
 * `normalizeText` (minúsculas, sin tildes, sin puntuación, espacios simples).
 */

export type ReminderReplyAction = 'YES' | 'CANCEL' | 'RESCHEDULE';

/**
 * Muletillas de saludo de varias palabras, ya normalizadas. Se quitan del
 * PRINCIPIO del mensaje antes de leer la intención: un "hola, quiero agendar
 * una cita" no puede consumirse como un saludo a secas (B1 del análisis del
 * bot). Orden importante: las frases largas van primero para que el match
 * greedy no corte a la mitad.
 */
const GREETING_PHRASES = [
  'muy buenos dias',
  'muy buenas tardes',
  'muy buenas noches',
  'buenos dias',
  'buenas tardes',
  'buenas noches',
  'buen dia',
  'como estas',
  'como esta',
  'como estan',
  'como andas',
  'como te va',
  'que tal',
  'que hay',
] as const;

/** Saludos de una sola palabra (texto ya normalizado). */
const GREETING_TOKEN_RE =
  /^(hola+|holis|buenas|buenos|saludos|hey|hi|hello|ola|oi)$/u;

/**
 * Palabras que indican que el paciente está pidiendo algo concreto, no
 * charlando. Se buscan en CUALQUIER posición del resto: "quiero agendar" y
 * "necesito cita" son pedidos reales aunque tengan solo dos palabras, y el
 * fraseo corto es el más común en WhatsApp (B1).
 */
const CONTENT_RE =
  /\b(agendar|agenda|agendo|agendame|reservar|reserva|turno|turnos|cita|citas|consulta|consultas|cupo|precio|precios|cuesta|cuestan|costo|cobran|valor|tarifa|horario|horarios|hora|horas|atienden|atiende|abren|abre|cierran|cierra|direccion|ubicacion|donde|cuando|cuanto|cuanta|cuantos|necesito|quiero|quisiera|puedo|podria|podrian|tienen|hay|disponible|disponibilidad|cancelar|reagendar|reprogramar|cambiar|mover|informacion|info|duele|dolor|urgencia|emergencia|presupuesto|pago|pagar|seguro)\b/u;

/**
 * Palabras que delatan que el mensaje pide OTRA cosa, aunque empiece con un
 * "sí". Sirven para no tragarse "sí, quiero agendar una cita" como si fuera la
 * confirmación de un recordatorio (B2). `cita` NO está en la lista a propósito:
 * "sí, confirmo mi cita" es una confirmación legítima.
 */
const OTHER_INTENT_RE =
  /\b(agendar|agenda|agendo|reservar|reserva|turno|turnos|cupo|cancelar|anular|reagendar|reprogramar|cambiar|mover|precio|precios|cuesta|costo|cobran|horario|horarios|direccion|ubicacion|donde|cuando|cuanto|humano|persona|duele|dolor)\b/u;

/**
 * Cierre de cortesía. Whitelist estricta y anclada a propósito: preferimos no
 * detectar un "gracias" raro antes que tragarnos un "gracias, quiero agendar"
 * y responder un cierre en vez de arrancar la FSM.
 *
 * Los separadores son ` ?` y no `\s*`: el contrato de entrada garantiza
 * espacios simples (`normalizeText`) y dos `\s*` adyacentes dan backtracking
 * cuadrático si alguien llamara a esta función con texto crudo.
 */
const CLOSING_RE =
  /^(ok|okay|okey|listo|perfecto|excelente|genial|buenisimo|vale|dale|bueno|de acuerdo)? ?(muchas|muchisimas|mil)? ?gracias( (de nuevo|por (todo|la info|la informacion|tu ayuda|su ayuda)))?$/u;

/**
 * Frases que sí son un pedido explícito de hablar con un humano.
 *
 * `persona` a secas NO deriva (B3 del análisis del bot): "es para otra
 * persona", "la persona que llamó ayer" o "soy la persona de contacto" son
 * mensajes normales, y sacaban al paciente del bot sin que lo pidiera.
 */
const HUMAN_ESCAPE_PHRASES = [
  'hablar con',
  'falar com', // pt
  'quiero una persona',
  'necesito una persona',
  'una persona por favor',
  'atienda una persona',
  'atiende una persona',
  'atienda un humano',
  'persona real',
  'pessoa real', // pt
  'ser humano',
  'agente humano',
  'atencion humana',
] as const;

/**
 * Palabras sueltas que sí son un pedido de humano. Familia con género y
 * plural: `humano`/`humana`/`humanos`, `asesor`/`asesora`, etc. `atendente` es
 * el término de pt-BR.
 */
const HUMAN_ESCAPE_TOKEN_RE =
  /^(human[oa]s?|operador[ae]?s?|asesor[ae]?s?|representante|atendente|attendant)$/u;

/** Cache de los `RegExp` de `startsWithAny` — se compilan una sola vez. */
const PREFIX_RE_CACHE = new Map<string, RegExp>();

/** Minúsculas, sin tildes, sin puntuación, espacios colapsados. */
export function normalizeText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[¡!¿?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countTokens(normalized: string): number {
  return normalized ? normalized.split(' ').length : 0;
}

/** ¿El texto normalizado arranca con alguna de estas palabras completas? */
export function startsWithAny(
  normalized: string,
  keywords: readonly string[],
): boolean {
  return keywords.some((keyword) => {
    let re = PREFIX_RE_CACHE.get(keyword);
    if (!re) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(`^${escaped}(?:\\b|$)`, 'u');
      PREFIX_RE_CACHE.set(keyword, re);
    }
    return re.test(normalized);
  });
}

/**
 * Quita del PRINCIPIO del mensaje los saludos, las muletillas ("que tal",
 * "buenos días", "cómo estás") y el nombre de la clínica, y devuelve el resto
 * TAL CUAL vino (con tildes y mayúsculas) para poder pasárselo al clasificador
 * y al RAG sin degradarlo.
 *
 * El match se hace token a token sobre la versión normalizada de cada palabra;
 * si una palabra normalizada contiene espacios (p. ej. "hola,quiero" sin
 * espacio después de la coma) no matchea nada y no se recorta — preferimos no
 * recortar antes que recortar de más.
 *
 * El nombre de la clínica solo se recorta si tiene al menos 4 caracteres: una
 * clínica llamada "A" no puede comerse el "a" de "a las 3".
 *
 * `matched` dice si se quitó algo; `rest` es lo que quedó (puede ser '').
 */
export function stripGreeting(
  text: string,
  clinicName: string,
): { matched: boolean; rest: string } {
  const rawTokens = text.trim().split(/\s+/).filter(Boolean);
  const normTokens = rawTokens.map((t) => normalizeText(t).replace(/\s+/g, ''));
  const normalizedClinic = normalizeText(clinicName);
  const clinicTokens =
    normalizedClinic.length >= 4 ? normalizedClinic.split(' ').filter(Boolean) : [];

  const matchesAt = (i: number, parts: readonly string[]): boolean =>
    parts.length > 0 && parts.every((part, k) => normTokens[i + k] === part);

  let i = 0;
  let matched = false;
  while (i < rawTokens.length) {
    let advanced = 0;
    for (const phrase of GREETING_PHRASES) {
      const parts = phrase.split(' ');
      if (matchesAt(i, parts)) {
        advanced = parts.length;
        break;
      }
    }
    if (!advanced && matchesAt(i, clinicTokens)) advanced = clinicTokens.length;
    if (!advanced && GREETING_TOKEN_RE.test(normTokens[i] ?? '')) advanced = 1;
    if (!advanced) break;
    matched = true;
    i += advanced;
  }

  return { matched, rest: rawTokens.slice(i).join(' ') };
}

/**
 * Después de recortar el saludo: ¿lo que queda es "nada que atender"?
 *
 * Es saludo si no queda nada, o si quedan ≤ 2 palabras sin ninguna palabra de
 * contenido ("todo bien", "y ustedes"). "quiero agendar", "cuánto cuesta" o
 * "horarios" SÍ son contenido aunque sean cortos — ese fraseo es el habitual
 * en WhatsApp y era justamente el bug B1.
 *
 * Recibe el resto YA NORMALIZADO (`normalizeText`), no el crudo.
 */
export function isBareGreeting(restNormalized: string): boolean {
  if (!restNormalized) return true;
  if (hasContent(restNormalized)) return false;
  return countTokens(restNormalized) <= 2;
}

/** ¿El texto menciona algo concreto (servicio, precio, horario, pedido)? */
export function hasContent(normalized: string): boolean {
  return CONTENT_RE.test(normalized);
}

/**
 * ¿El mensaje pide OTRA cosa además de decir que sí? Se usa para decidir si un
 * "sí…" es la confirmación de un recordatorio o el arranque de otro flujo.
 */
export function asksForSomethingElse(normalized: string): boolean {
  return OTHER_INTENT_RE.test(normalized);
}

/** Cierre de cortesía ("ok, gracias") → respuesta corta, sin LLM. */
export function isCourtesyClosing(normalized: string): boolean {
  return normalized.length > 0 && CLOSING_RE.test(normalized);
}

/** Palabras del recordatorio: SÍ / CANCELAR / REAGENDAR. */
export function parseReminderReply(
  normalized: string,
): ReminderReplyAction | null {
  if (startsWithAny(normalized, ['si', 'confirmo', 'confirmar', 'ok', 'dale'])) {
    return 'YES';
  }
  if (startsWithAny(normalized, ['cancelar', 'cancela', 'cancelo', 'anular'])) {
    return 'CANCEL';
  }
  if (startsWithAny(normalized, ['reagendar', 'reprogramar'])) {
    return 'RESCHEDULE';
  }
  return null;
}

/**
 * `si` / `ok` / `dale` son ambiguos: valen como respuesta a un recordatorio
 * solo si hay contexto (ver `BotService.hasConfirmationContext`).
 * `confirmo` / `confirmar` son verbos explícitos y pasan siempre.
 */
export function isAmbiguousYes(normalized: string): boolean {
  return startsWithAny(normalized, ['si', 'ok', 'dale']);
}

/** Aborta la FSM en curso. */
export function isFlowAbort(normalized: string): boolean {
  return startsWithAny(normalized, [
    'cancelar',
    'cancela',
    'cancelo',
    'abortar',
    'salir',
  ]);
}

/**
 * Detecta si el paciente pide hablar con una persona en cualquier paso del
 * flujo: palabras sueltas de `HUMAN_ESCAPE_TOKEN_RE` o frases de
 * `HUMAN_ESCAPE_PHRASES`.
 */
export function isHumanEscape(normalized: string): boolean {
  if (!normalized) return false;
  if (HUMAN_ESCAPE_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }
  return normalized
    .split(/\s+/)
    .some((token) => HUMAN_ESCAPE_TOKEN_RE.test(token));
}
