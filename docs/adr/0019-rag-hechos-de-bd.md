---
status: accepted
date: 2026-09-11
tags: [bot, rag, knowledge, multi-tenant, prisma]
---

# ADR 0019 — Hechos de BD como fuente del RAG (sin embeddings)

## Contexto

El RAG del bot ([[../notas/2026-08-09-rag-faq]]) sólo respondía desde `FaqChunk`
(texto libre cargado a mano en `/panel/faq`, con embeddings). Eso deja afuera
datos que YA existen estructurados en la BD y cambian con el tiempo: horario
(`BusinessHour`), servicios y precios (`Service`), profesionales
(`Professional`), y la próxima cita del paciente que escribe (`Appointment`).

Hoy, si un paciente pregunta "¿cuánto cuesta la limpieza?" y nadie cargó esa
FAQ a mano (o el precio cambió y la FAQ quedó vieja), el bot hace handoff
aunque la respuesta correcta está a un `SELECT` de distancia. Mantener FAQs
sincronizadas con precios/horarios reales es trabajo manual duplicado — la
fuente de verdad ya es la BD.

Además, con el diseño anterior, `retrieve()` devolviendo 0 matches cortaba en
seco (`return null`) sin siquiera intentar el LLM — aunque hubiera datos de BD
disponibles para responder.

Alcance de este ADR: análisis del bot §5 M1
([[../analisis/2026-09-11-chatbot-analisis-tecnico]]), plan de reparto
[[../planes/2026-09-11-p0-bot-reparto]] (PR B2).

## Decisión

**`ClinicFactsService.build(clinicId, phone?)`** arma un bloque de **texto
plano, formato fijo** (no embeddings, no pgvector) con:

- Clínica: nombre, dirección, WhatsApp público (si existen).
- Horario de atención (`BusinessHour` de la clínica, `professionalId = null`),
  agrupado por rangos consecutivos ("Lunes a viernes 8:00 a 17:00.").
- Servicios activos: nombre, duración, precio con `Clinic.currency` — **nunca
  inventa un precio**: `priceCents = null` → "precio a consultar".
- Profesionales activos: nombre, especialidad, servicios que atiende.
- Si viene `phone` y existe `Patient` de ESA clínica: su próxima cita activa
  (servicio, profesional, fecha en TZ/locale de la clínica vía Luxon, estado
  en palabras). Nunca el nombre del paciente ni otro dato — sólo la cita.

`KnowledgeService.answer()` antepone este bloque como
`--- FUENTE BD ---\n{facts}\n--- FIN FUENTE BD ---` a las fuentes de FAQ
(mismos delimitadores anti-injection que ya existían). El prompt agrega:
"Si el dato no aparece en las fuentes, responde NULL_ANSWER. No calcules ni
estimes precios ni horarios que no estén escritos." — el LLM sigue siendo
quien decide `NULL_ANSWER`, nunca inventa.

**Cambio de umbral de entrada**: antes, `matches.length === 0` cortaba sin
llamar al LLM. Ahora, si no hay FAQ matches pero SÍ hay hechos de BD, se llama
igual al LLM con solo `FUENTE BD` — el LLM decide si puede responder. Sigue
cortando (return `null`) si no hay matches NI hechos (nada que darle al LLM) o
si falta `OPENAI_API_KEY` (`KnowledgeUnavailableError`, sin cambios).

### ¿Por qué texto plano y no embeddings de estos datos?

- Los hechos de BD son estructurados y pequeños por clínica (~10-50
  servicios/profesionales en el MVP) — no hace falta similitud semántica,
  alcanza con "dame todo lo vigente" en cada llamada.
- Evita re-embeder cada vez que cambia un precio o un horario (con FAQ, cada
  edición dispara un embed; acá el dato sale directo de la tabla).
- Consistencia inmediata: el LLM ve el precio/horario ACTUAL, no una foto
  vieja que alguien olvidó reindexar.

### ¿Por qué cache Redis 60s sólo en la parte sin paciente?

- La parte "clínica + horario + servicios + profesionales" es la misma para
  cualquier paciente que pregunte — cachearla evita 3 queries (`businessHour`,
  `service`, `professional`) por cada pregunta de FAQ. TTL corto (60s, mismo
  patrón que [[../../apps/backend/src/common/redis/clinic-status.cache.ts|ClinicStatusCache]])
  porque un cambio de precio/horario en `/panel` debe reflejarse rápido sin
  necesitar invalidación explícita.
- La línea de "próxima cita" es por-paciente y NUNCA se cachea con esa clave
  — cachearla arriesgaría servirle a un paciente la cita de otro si dos
  preguntan dentro de la misma ventana de 60s. Se recalcula siempre.
- Fail-open respecto a Redis (igual que `ClinicStatusCache`): si Redis falla,
  se calcula de DB directo; nunca se bloquea la respuesta por eso.

### Tope de ~2000 caracteres

Bound duro del bloque cacheable para no inflar el prompt (costo + latencia)
en clínicas con muchos servicios/profesionales. Si se pasa, se recorta la
lista más larga (servicios o profesionales, alternando) hasta entrar en el
tope, agregando "…y N más." — nunca corta el horario ni los datos de la
clínica (son de tamaño acotado por diseño).

## Consecuencias

- El bot puede responder preguntas de precio/horario/profesional SIN que
  nadie haya cargado una FAQ para eso — reduce handoffs.
- Las FAQ siguen existiendo para lo que NO está estructurado (políticas,
  preguntas frecuentes cualitativas, "¿aceptan mi seguro?").
- `KnowledgeService.answer()` ahora depende de `ClinicFactsService` (inyectado
  vía `KnowledgeModule`) — sigue funcionando igual si `ClinicFactsService`
  devuelve `''` (clínica sin horario/servicios cargados: se comporta como
  antes de este ADR).
- Wiring pendiente (deuda de ESTE PR, a cargo de otra rama): `bot.service.ts`
  todavía no pasa `phone: convo.phone` a `knowledge.answer()` — sin eso, el
  bloque de hechos sale sin la línea de "próxima cita" (el resto funciona
  igual). Una línea, ver plan B2 punto 4.
- Deuda no resuelta acá (post-piloto): cache de la línea de próxima cita con
  invalidación por escritura (hoy se recalcula siempre — barato pero es una
  query extra por pregunta con `phone`); considerar mover el prompt de
  precios a una tabla de tarifas por clínica+moneda si se agrega multi-moneda
  real.
