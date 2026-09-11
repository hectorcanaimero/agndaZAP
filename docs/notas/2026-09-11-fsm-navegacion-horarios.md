---
titulo: "FSM del bot: más horarios, cualquier profesional y preferencias"
fecha: 2026-09-11
tags: [bot, fsm, agendamiento, m4]
---

# Navegación de horarios en la FSM (M4)

La FSM ofrecía seis horarios de los próximos 7 días de un profesional concreto y no
tenía más salida que acertar el número o abandonar. Cuatro cambios, todos en
`ASK_PROFESSIONAL` / `ASK_SLOT`.

## 1. "0. Ver más horarios"

`flowData.slotWindowCount` es la página: 0 son los próximos 7 días, 1 los 7
siguientes. La opción solo se ofrece mientras queden ventanas.

**Tope de 4 ventanas (≈ un mes)** y después el link tokenizado de
`buildSchedulingLink`. Más que eso y elegir por chat deja de tener sentido frente al
form web, que muestra un calendario. Al llegar al tope **no reseteamos la FSM**: los
horarios ya mostrados siguen siendo elegibles por número.

Si una ventana avanzada no trae nada, tampoco reseteamos — el paciente ya demostró
interés, lo que corresponde es darle el calendario completo, no echarlo del flujo.

## 2. "Cualquier profesional"

Última opción de `ASK_PROFESSIONAL` cuando hay más de uno. La mayoría no tiene
preferencia y obligarlos a elegir agrega un paso que no aporta.

Se pide `getSlots` por cada profesional y se mezcla por fecha. **El dueño de cada
slot se guarda en `flowData.offeredProfessionalIds`, paralelo a `offeredSlots`**, y
el `professionalId` real se fija recién cuando el paciente elige el horario. Si dos
profesionales ofrecen la misma hora, se la queda el primero por orden de nombre: la
query ya viene ordenada, así que el reparto es estable y no depende del orden en que
resuelvan las promesas.

**Gotcha**: `resolveChoice` resuelve por substring del label, y "cualquiera" NO está
contenido en "Cualquier profesional" — que es justo la palabra que usa la gente. Por
eso hay un `isNoPreferenceChoice` aparte que cubre "cualquiera", "el que sea", "me da
igual", "indiferente", "lo antes posible". Lo descubrió un test que escribí con la
palabra natural en vez del número.

## 3. Preferencia mencionada de paso

`parseSlotPreference` (en `message-matching.ts`, función pura) lee franja horaria y
día del mismo mensaje con el que el paciente elige servicio o profesional ("1, por la
tarde", "el martes"). El filtro se aplica **antes de mostrar** la lista.

Si el filtro deja la lista vacía, lo decimos y mostramos la lista completa: un "no hay
nada" a secas suena a que la agenda está llena, cuando lo que falta es esa franja.

También se acepta en `ASK_SLOT` un mensaje sin número pero con preferencia ("mejor por
la tarde") → re-filtra en vez de responder "no te entendí".

**Ambigüedad de "mañana"**: en español es franja horaria *y* día siguiente. La regla:
solo cuenta como franja con preposición ("por la mañana", "en la mañana", "de
mañana"); un "mañana" suelto es el día siguiente, que es como lo usa la gente.

## 4. Salida al form web tras dos intentos

`flowData.invalidCount` cuenta respuestas seguidas que no pudimos interpretar en el
paso actual; se reinicia con cada respuesta válida. Al segundo fallo se anexa el link
tokenizado.

**Sin resetear la FSM**: quien se atascó tiene una puerta, y quien prefiere seguir por
chat puede seguir. Repetir la misma lista una tercera vez es la vía rápida a que el
paciente abandone.

Relacionado: [[notas/2026-09-11-bot-matching-saludo-si-persona]].
