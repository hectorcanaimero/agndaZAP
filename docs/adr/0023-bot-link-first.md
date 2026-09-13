---
status: accepted
date: 2026-09-13
tags: [bot, scheduling, whatsapp, web, producto]
---

# ADR 0023 — Bot link-first: agendar y reagendar por link, no por chat

## Contexto

Hasta ahora el bot agendaba con una FSM por chat (`ASK_SERVICE → ASK_PROFESSIONAL → ASK_SLOT →
ASK_NAME → CONFIRM`) y reagendaba reusando el paso de horarios (B5). El link de la web era la
excepción: el caso `@lid` sin teléfono ([[0018-scheduling-link-wa]]) o la salida tras dos
respuestas sin entender (M4).

El 2026-09-13 el owner probó agendar por WhatsApp contra `main` 6bad599 y el bot se perdió en el
paso de horarios (detalle en [[specs/2026-09-13-bot-link-first]]):

- cada tanda es una semana y solo muestra los 6 primeros horarios, así que eran todos del lunes
  por la mañana;
- "ver más" saltaba a la semana siguiente: del martes al viernes no se llegaba nunca;
- "tienes para el día 15" se leía como la opción 15;
- "cualquera" no casaba con "cualquier profesional".

Cada arreglo posible (fechas en lenguaje natural, paginar por día, fuzzy matching) añade superficie
donde el bot divaga. La web ya resuelve lo mismo con un calendario, el token con prefill de 0018 y
la gestión de cita de [[0020-gestion-cita-por-link]].

## Decisión

**El chat detecta la intención y manda el link; nunca pregunta servicio, profesional ni horario.**

- **Agendar** (`Intent.AGENDAR`) → link con token (`?t=`), con nombre y teléfono del chat. Si
  Redis no emite el token, el link público sin token.
- **Reagendar** (`REAGENDAR` o `Intent.REPROGRAMAR`) → link de gestión. Sin link, recepción; nunca
  la lista de horarios por chat.
- **Se quedan en el chat**, por decisión del owner, las respuestas cerradas que no pueden divagar:
  - `SÍ` para confirmar asistencia (núcleo anti no-show);
  - `CANCELAR` con la palabra exacta: determinista, sin LLM, libera el turno sin abrir un
    navegador. Un "no voy a poder ir" en texto libre recibe el link de gestión, como ya hacía.
- Conversaciones que quedaron a mitad de la FSM al desplegar salen al link (o al de gestión si
  estaban moviendo una cita). "cancelar" en ese estado pausa, como antes.
- **Aviso por WhatsApp** al crear, mover o cancelar desde la web, que antes no existía: sin él el
  paciente vuelve al chat sin un "listo". Solo a quien ya tiene conversación con la clínica; nunca
  abre un chat desde el formulario público (cualquiera puede escribir el teléfono de otro, y el
  número de la clínica acabaría baneado).
- **Token de agendamiento caducado → cita `PUBLIC`**, no 400. El token no autoriza nada que el
  formulario no permita sin él; solo ata la conversación. Con el link como camino normal, abrirlo
  pasados 30 min es lo habitual.
- **Flag `BOT_CHAT_BOOKING_ENABLED`** (apagado por defecto) restaura FSM y textos como vuelta atrás
  durante el piloto. Global y no por clínica: aún no hay piloto, y por tenant exige migración y UI.

## Alternativas consideradas

### Arreglar la FSM (fechas en lenguaje natural, paginar por día)
Cierra los tres fallos observados, pero no la clase de fallo: elegir fecha y hora es una
conversación abierta, y cada mejora del parser abre casos nuevos. Además duplica, peor, un
calendario que la web ya tiene. **Rechazada.**

### Link-first con la FSM como alternativa ("o escríbeme aquí")
Mantiene el camino que divaga y obliga a mantener los dos. El owner quiere que nunca divague.
**Rechazada.**

### Todo por link, también `CANCELAR` y `SÍ`
Más uniforme, pero el paciente que no abre el link deja el turno ocupado, que es exactamente el
no-show que el producto existe para evitar. Una palabra fija no divaga. **Rechazada por el owner.**

### Borrar la FSM ya, sin flag
Diff más limpio, pero sin vuelta atrás rápida si la conversión por link resulta mala en el piloto.
El flag cuesta poco: los pools link-first se eligen en `botCopy` y la suite de la FSM corre con el
flag encendido. **Diferida**: se borra al cerrar el piloto.

## Consecuencias

### Positivas
- El bot deja de tener un camino donde se pierde al agendar o reagendar.
- Menos llamadas al LLM por cita: una clasificación en vez de varias vueltas.
- El paciente elige día y hora en un calendario, ve todos los días y cambia de opinión sin
  reescribir.
- Las citas del chat quedan medibles: `source = BOT_WEB` (con token) frente a `PUBLIC`.

### Negativas
- **Fricción**: salir de WhatsApp al navegador. Parte de los pacientes (poca conexión, mayores) no
  terminará. Hay que medir la conversión `BOT_WEB` en el piloto; el flag es la salida si es mala.
- **Cambia la promesa del PRD**: el paciente ya no "agenda por WhatsApp", el asistente le lleva a
  reservar en un toque y le confirma por WhatsApp.
- Con token caducado la cita pierde el `conversationId`. El aviso cae a la búsqueda por teléfono,
  que no existe en un chat `@lid`: ese paciente no recibe el "listo" (sí lo ve en `/gracias`).
- `WahaService` pasa a `WahaClientModule` (hoja): importar `WhatsappModule` desde `PublicModule`
  cerraba un ciclo de archivos y `BotModule` arrancaba con un import `undefined`. Ver
  [[notas/2026-09-13-ciclo-modulos-public-whatsapp]].

### Neutrales
- La FSM y su suite siguen en el código hasta el cierre del piloto.

## Enlaces
- [[specs/2026-09-13-bot-link-first]] — requisitos R1-R7 y escenarios.
- [[0018-scheduling-link-wa]] — token de agendamiento (deja de ser excepción).
- [[0020-gestion-cita-por-link]] — gestión de cita (reagendar por chat desaparece).
- `apps/backend/src/bot/chat-booking.flag.ts`, `bot.service.ts` (`sendBookingLink`,
  `leaveChatBookingFlow`), `public/patient-whatsapp-notifier.service.ts`.
