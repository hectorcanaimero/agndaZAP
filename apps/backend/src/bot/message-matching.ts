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
 *
 * **Las palabras clave son es + pt a la vez, no por idioma de la clínica**
 * (B7). Entender de más no hace daño —un paciente de una clínica `pt` que
 * escriba "sí" quiere decir que sí— y evita que el matching dependa de un
 * campo que puede estar mal configurado. Lo que SÍ depende del idioma es lo
 * que el bot RESPONDE: eso vive en `bot.messages.ts`.
 *
 * Como `normalizeText` quita las tildes, el portugués entra sin acentos:
 * `não`→`nao`, `olá`→`ola`, `terça`→`terca`.
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
  // pt
  'muito bom dia',
  'bom dia',
  'boa tarde',
  'boa noite',
  'tudo bem',
  'tudo bom',
  'como vai',
  // es
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
  /^(hola+|holis|buenas|buenos|saludos|hey|hi|hello|ola+|oi+|oie|alo)$/u;

/**
 * Palabras que indican que el paciente está pidiendo algo concreto, no
 * charlando. Se buscan en CUALQUIER posición del resto: "quiero agendar" y
 * "necesito cita" son pedidos reales aunque tengan solo dos palabras, y el
 * fraseo corto es el más común en WhatsApp (B1).
 */
const CONTENT_RE =
  /\b(agendar|agenda|agendo|agendame|marcar|remarcar|reservar|reserva|turno|turnos|cita|citas|consulta|consultas|cupo|vaga|precio|precios|preco|precos|cuesta|cuestan|custa|costo|cobran|cobram|valor|tarifa|horario|horarios|hora|horas|atienden|atiende|atendem|atende|abren|abre|abrem|cierran|cierra|fecham|direccion|ubicacion|endereco|donde|onde|cuando|quando|cuanto|cuanta|cuantos|quanto|quantos|necesito|preciso|quiero|quero|quisiera|queria|puedo|posso|podria|podrian|poderia|tienen|tem|teem|hay|disponible|disponivel|disponibilidad|disponibilidade|cancelar|reagendar|reprogramar|cambiar|mudar|mover|informacion|informacao|info|duele|doi|dolor|dor|urgencia|emergencia|presupuesto|orcamento|pago|pagar|seguro|convenio)\b/u;

/**
 * Palabras que delatan que el mensaje pide OTRA cosa, aunque empiece con un
 * "sí". Sirven para no tragarse "sí, quiero agendar una cita" como si fuera la
 * confirmación de un recordatorio (B2). `cita` NO está en la lista a propósito:
 * "sí, confirmo mi cita" es una confirmación legítima.
 */
const OTHER_INTENT_RE =
  /\b(agendar|agenda|agendo|marcar|reservar|reserva|turno|turnos|cupo|vaga|cancelar|anular|reagendar|reprogramar|remarcar|cambiar|mudar|mover|precio|precios|preco|precos|cuesta|custa|costo|cobran|cobram|horario|horarios|direccion|ubicacion|endereco|donde|onde|cuando|quando|cuanto|quanto|humano|persona|pessoa|duele|doi|dolor|dor)\b/u;

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
  /^(ok|okay|okey|listo|pronto|perfecto|perfeito|excelente|genial|otimo|buenisimo|vale|dale|bueno|beleza|blz|ta bom|de acuerdo)? ?(muchas|muchisimas|mil|muito|muitissimo)? ?(gracias|obrigad[oa]|valeu)( (de nuevo|de novo|por (todo|tudo|la info|la informacion|tu ayuda|su ayuda|a ajuda|sua ajuda)))?$/u;

/**
 * Frases que sí son un pedido explícito de hablar con un humano.
 *
 * `persona` a secas NO deriva (B3 del análisis del bot): "es para otra
 * persona", "la persona que llamó ayer" o "soy la persona de contacto" son
 * mensajes normales, y sacaban al paciente del bot sin que lo pidiera.
 */
const HUMAN_ESCAPE_PHRASES = [
  'hablar con',
  'falar com',
  'quero uma pessoa',
  'preciso de uma pessoa',
  'uma pessoa por favor',
  'atendimento humano', // pt
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
  if (
    startsWithAny(normalized, [
      'si',
      'sim',
      'confirmo',
      'confirmar',
      'ok',
      'dale',
      'beleza',
      'blz',
    ])
  ) {
    return 'YES';
  }
  if (
    startsWithAny(normalized, [
      'cancelar',
      'cancela',
      'cancelo',
      'anular',
      'desmarcar',
    ])
  ) {
    return 'CANCEL';
  }
  if (startsWithAny(normalized, ['reagendar', 'reprogramar', 'remarcar'])) {
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
  return startsWithAny(normalized, ['si', 'sim', 'ok', 'dale', 'beleza', 'blz']);
}

/** Aborta la FSM en curso. */
export function isFlowAbort(normalized: string): boolean {
  return startsWithAny(normalized, [
    'cancelar',
    'cancela',
    'cancelo',
    'desmarcar',
    'abortar',
    'salir',
    'sair',
    'parar',
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

/**
 * Preferencia de horario que el paciente menciona de paso, en el mismo mensaje
 * con el que elige servicio o profesional ("el martes por la tarde", "mañana",
 * "algo temprano"). Sirve para filtrar la lista ANTES de mostrarla (M4).
 *
 * `weekday` usa la numeración de Luxon (1 = lunes … 7 = domingo).
 * `relativeDay` cubre el "mañana" que significa *el día siguiente*, no la
 * franja horaria — la ambigüedad del español que más se cruza aquí.
 */
export interface SlotPreference {
  period?: 'manana' | 'tarde';
  weekday?: number;
  relativeDay?: 'hoy' | 'manana';
}

const WEEKDAYS: Record<string, number> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  domingo: 7,
  // pt — `segunda`/`terca` sin el "-feira", que es como se escribe en un chat.
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
};

/**
 * Devuelve `null` si el mensaje no expresa ninguna preferencia.
 *
 * Desambiguación de "mañana": solo cuenta como franja horaria cuando viene
 * con preposición ("por la mañana", "en la mañana", "de mañana"). Un "mañana"
 * suelto es el día siguiente, que es como lo usa la gente.
 */
export function parseSlotPreference(normalized: string): SlotPreference | null {
  const pref: SlotPreference = {};

  const morningPhrase =
    /\b(por|en|de|a) la manana\b|\bde manana\b|\btemprano\b|\bde manha\b|\bpela manha\b|\bcedo\b/u;
  const afternoonPhrase =
    /\b(por|en|de|a) la tarde\b|\bde tarde\b|\bde tarde\b|\ba tarde\b|\btarde\b/u;
  if (morningPhrase.test(normalized)) pref.period = 'manana';
  else if (afternoonPhrase.test(normalized)) pref.period = 'tarde';

  if (!pref.period && /\bmanana\b|\bamanha\b/u.test(normalized)) {
    pref.relativeDay = 'manana';
  } else if (/\bhoy\b|\bhoje\b/u.test(normalized)) {
    pref.relativeDay = 'hoy';
  } else if (pref.period === 'manana' && /\bmanana manana\b/u.test(normalized)) {
    pref.relativeDay = 'manana';
  }

  for (const [name, n] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`, 'u').test(normalized)) {
      pref.weekday = n;
      break;
    }
  }

  return Object.keys(pref).length > 0 ? pref : null;
}

/**
 * "Cualquiera", "el que sea", "me da igual": el paciente no tiene preferencia
 * de profesional (M4). Va aparte de `resolveChoice` porque esa resuelve por
 * substring del label, y "cualquiera" no está contenido en "Cualquier
 * profesional" — que es justo la palabra que usa la gente.
 */
const ANY_CHOICE_RE =
  /\b(cualquier|cualquiera|qualquer|el que sea|la que sea|quien sea|o que for|tanto faz|me da igual|da igual|indiferente|sin preferencia|no tengo preferencia|sem preferencia|el primero|o primeiro|lo antes posible|o quanto antes)\b/u;

export function isNoPreferenceChoice(normalized: string): boolean {
  return ANY_CHOICE_RE.test(normalized);
}
