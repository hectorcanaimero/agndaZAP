# ADR 0007 — Rate-limit del bot de WhatsApp (protección de LLM budget)

- Fecha: 2026-08-09
- Estado: aceptado (piloto)
- Relacionados: [[0003-rate-limit-casero-vs-throttler]], [[0004-pii-y-compliance]],
  [[../notas/2026-08-09-rag-faq]]

## Contexto

El bot procesa cada mensaje entrante por WhatsApp con:

1. Detección de intención (DeepSeek + fallback Gemini) → 1 llamada LLM.
2. Si intent = `PREGUNTA_FAQ`: embedding OpenAI (1 llamada) + synthesis
   DeepSeek/Gemini (1 llamada). Total: 3 llamadas LLM.
3. Si intent = `AGENDAR`: entra a la FSM (0 llamadas LLM adicionales por
   respuesta — las opciones son deterministas).

Sin rate-limit, un atacante o bot puede:

- Spamear 1000 mensajes/min a un solo chatId → 1000-3000 llamadas LLM.
- Distribuir spam entre varios chatIds contra la misma clínica → mismo efecto,
  sin límite por conversación.

Cada llamada tiene costo: DeepSeek ~$0.0001/1k tokens, OpenAI ~$0.02/1M tokens,
Gemini ~free-hasta-cuota. El vector económico no es catastrófico en absoluto,
pero **una clínica con budget agotado deja de responder a pacientes reales** —
peor que el downtime aislado del bot.

Además, cada mensaje entrante:
- Escribe una fila en `Message` (con `direction: 'IN'`).
- Escribe una fila en `Message` (con `direction: 'OUT'`, la respuesta).
- Puede escribir/actualizar `Conversation`.

Un ataque sostenido llenaría la DB en horas.

## Decisión

Dos capas de rate-limit en Redis, aplicadas en `BotService.handleIncoming`
ANTES de todo procesamiento (upsert de Conversation, INSERT de Message,
detección de intent):

### Capa 1: por conversación (chatId)

- Clave: `bot:msg:{clinicId}:{chatId}:{minuteBucket}`.
- Ventana: 60 segundos (fixed window).
- Cap: **15 mensajes/minuto por conversación**.
- Al superar: **silencio total** — no se responde al spammer.

Racional del cap:
- Un paciente REAL raramente supera 5 mensajes/min (aún corrigiendo respuestas).
- 15 da margen para casos de "tapping" (varios mensajes cortos seguidos: "hola",
  "estoy?", "sos el bot?"), que son legítimos.
- Con 15, el peor caso de LLM burn por conversación es 15*3=45 llamadas/min.
  Aceptable.

Racional del silencio (no error visible):
- Responder "demasiadas solicitudes" AMPLIFICARÍA el ataque: cada mensaje del
  atacante genera una respuesta, y estamos comprándole tráfico gratis a WhatsApp.
- Un usuario legítimo que golpea el cap por accidente (typos rápidos) se
  autocorrige: al mandar el 16to no le llega respuesta, para, y al minuto
  siguiente puede volver.

### Capa 2: circuit breaker por clínica/hora

- Clave: `bot:msg:{clinicId}:hour:{hourBucket}`.
- Ventana: 1 hora (fixed window).
- Cap: **500 mensajes/hora por clínica**.
- Al superar: **circuit OPEN** — bot deja de procesar todo mensaje para esa
  clínica hasta el siguiente bucket. Log a `error` para alertar al operador.

Racional del cap:
- Una clínica con 20 profesionales atendiendo 40 pacientes/día tendría un
  máximo estimado de 200 mensajes bot/día, ~30/hora en pico.
- 500/hora es 15x el pico esperado. Suficiente margen para eventos legítimos
  (ej: campaña de recordatorios masiva) SIN dejar que un ataque distribuido
  entre chatIds evada la capa 1.

Racional del cierre total:
- Si una clínica ya generó 500 msgs/hora, algo está mal: o hay ataque, o hay
  un bug en el bot loopeando. En ambos casos, PARAR es más seguro que seguir
  quemando LLM budget mientras diagnósticamos.

### Fail-open si Redis está caído

Si `redis.incr` falla, loggeamos `error` y seguimos procesando. Racional
idéntico al de `rate-limit.guard.ts` (Bloque 3): fail-closed sería un DoS
auto-infligido (Redis se cae → bot se muere). La protección real la dan
`unique(professionalId, startAt)` en Postgres (anti doble-reserva) y el
resto de los rate-limits (endpoint público).

### Cero PII en logs

El `chatId` incluye el número E.164 del paciente (`@c.us` sufijo). Loguearlo
crudo filtra PII. En su lugar, loggeamos `sha256(chatId).slice(0, 8)` — 32
bits, suficiente para correlacionar eventos de la misma conversación en logs
sin exponer el identificador real.

## Alternativas descartadas

- **Rate-limit sólo por chatId (sin circuit breaker por clínica)**: no protege
  contra ataques distribuidos entre chatIds.
- **Rate-limit sólo por clínica (sin capa por chat)**: un chat spammer solo
  consumiría todo el budget de la clínica antes de disparar el circuit.
- **Fail-closed cuando Redis se cae**: el bot deja de responder cada vez que
  hay un blip en Redis. Peor para pacientes reales.
- **Sliding window con sorted sets**: más caro (ZADD + ZREMRANGEBYSCORE por
  request) y no aporta valor real para caps chicos como 15/min.
- **Rate-limit en WAHA en vez de en el bot**: WAHA no lo soporta out-of-the-box.
  Y ya recibimos el mensaje al llegar al webhook — el costo de escribir a DB
  no se ahorra.

## Ajustar thresholds

- Si una clínica legítima golpea el cap por clínica/hora, subir a 1000/hora
  temporalmente y auditar tráfico. El cap NO debería ser dinámico por clínica
  hasta post-piloto (agrega complejidad de multi-tenant config).
- Si el cap por chat molesta a pacientes reales, subir a 20 pero NO a 30 —
  arriba de eso el vector económico se pone caro.
- Ambos caps son constantes de clase en `BotService`:
  - `PER_CHAT_LIMIT = 15`
  - `PER_CLINIC_HOURLY_LIMIT = 500`

## Métricas a monitorear (post-piloto)

- `bot rate-limit HIT` warnings/hora por clínica → detectar ataques activos.
- `bot hourly cap` errors → alertar en Slack inmediato.
- Ratio `mensajes IN / mensajes OUT` por clínica → si diverge mucho, el rate-limit
  está actuando (silencio en OUT).

## Deuda para post-piloto

- Métrica agregada por Prometheus (bot_messages_total{clinic, status=allowed|dropped}).
- Rate-limit dinámico por clínica (tabla `clinic.botRateLimit`).
- Notificación proactiva al operador cuando el circuit se abre.
- Regla ad-hoc: si el mismo `chatId` genera 3 circuit-breaker HITs consecutivos
  en 24h, marcar la conversación en `state = 'BLOCKED'` para revisión humana.
