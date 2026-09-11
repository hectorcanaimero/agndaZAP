---
titulo: "Bot: el saludo se recorta, el \"sí\" necesita contexto y \"persona\" no deriva"
fecha: 2026-09-11
tags: [bot, matching, nlu, p0]
---

# Matching del bot: B1 + B2 + B3

Tres bugs de [[analisis/2026-09-11-chatbot-analisis-tecnico]] (§4) que compartían
raíz: la escalera de `handleIncoming` tomaba decisiones mirando solo el **principio**
del mensaje y consumiéndolo entero.

## B1 — el saludo se comía el mensaje

Antes: `GREETING_REGEX.test(normalized)` → respondía el saludo y `return`. Un
`"hola, quiero agendar una cita"` recibía el menú genérico y el paciente tenía que
repetir lo que ya había escrito.

Ahora `stripGreeting(text, clinicName)` **recorta** del principio los saludos, las
muletillas (`que tal`, `buenos días`, `cómo estás`…) y el nombre de la clínica, y
devuelve el resto **sin normalizar** (con tildes y mayúsculas) para no degradar lo
que va al clasificador y al RAG. Si lo que queda está vacío, o son ≤ 2 palabras sin
ninguna palabra de contenido ("todo bien", "y ustedes") → saludo, como antes. Si
queda contenido, se sigue la escalera con el texto recortado.

Detalle que costó una segunda pasada: la primera versión miraba solo el **inicio**
del resto, así que `"hola quiero agendar"` (2 palabras tras recortar) seguía cayendo
en el saludo — y el fraseo corto es justamente el más común en WhatsApp. `CONTENT_RE`
busca palabras de contenido (`agendar`, `cita`, `cuesta`, `horario`, `quiero`,
`necesito`…) en **cualquier** posición del resto.

Decisión no obvia: el match se hace token a token sobre la versión normalizada de
cada palabra. Si una palabra normalizada queda con espacios adentro (`"hola,quiero"`
sin espacio tras la coma) no matchea y **no se recorta**: preferimos no recortar
antes que recortar de más y perder parte del pedido.

## B2 — `SÍ` / `OK` / `DALE` confirmaban cualquier cosa

`parseReminderReply` mapeaba a `YES` cualquier mensaje que empezara con `si`, `ok` o
`dale`, sin importar si había algo que confirmar. `"sí, quiero agendar"` confirmaba
una cita vieja; `"ok gracias"` respondía *"No encontré una cita próxima…"*.

Ahora se separan dos clases:

- **Verbos explícitos** (`confirmo`, `confirmar`, `cancelar`, `reagendar`): pasan
  siempre, como antes. No son ambiguos.
- **Ambiguos** (`si`, `ok`, `dale`): valen como respuesta solo si **el bot preguntó
  primero**. Si además el mensaje nombra otra cosa (`"sí, quiero agendar una cita"`,
  `"sí, cuánto cuesta?"`) va al clasificador. Sin contexto se responde el menú: ni
  *"no encontré cita"*, que suena a error, ni *"responde SÍ"*, que sería un bucle.

### Qué cuenta como "el bot preguntó primero"

`hasConfirmationContext` mira dos fuentes, en ese orden:

1. **El último mensaje `OUT` de la conversación contiene `*SÍ*`.** Imprescindible:
   `greetingWithAppointment` y la rama `Intent.CONFIRMAR` piden *"responde **SÍ**"*
   sin crear ningún `Reminder`. El criterio del plan (solo `Reminder` SENT) hacía que
   el bot castigara con el menú genérico la respuesta que él mismo acababa de pedir.
2. **Un `Reminder` con `status = SENT` y `sentAt` en las últimas 48 h** para una cita
   próxima de ese teléfono en esa clínica — el recordatorio anti no-show, que puede
   llegar días después del último mensaje.

`Reminder` no tiene `clinicId` propio, así que el filtro multi-tenant va sobre la
cita (`appointment.clinicId`) y sobre el paciente (`appointment.patient.clinicId`).

El corte por longitud (≤ 2 palabras) que proponía el plan se reemplazó por el filtro
de "¿nombra otra cosa?": con el corte, `"sí por favor"` y `"sí, confirmo mi cita"`
dejaban de confirmar y se iban al LLM, contra lo que promete el SPEC
(confirmaciones sin depender del modelo).

Se agregó además un **cierre de cortesía**: `"ok gracias"`, `"muchas gracias"`,
`"gracias por todo"` → respuesta corta del pool `closing`, sin LLM. La detección es
una whitelist anclada (`^…$`) a propósito: `"gracias, quiero agendar"` NO es un
cierre y sigue a la FSM.

`IntentService.detectDeterministic` aplica la misma regla de ≤ 2 palabras para
`si/ok/dale`, para que el clasificador no contradiga a la escalera.

## B3 — `persona` sacaba al paciente del bot

`isHumanEscape` derivaba a humano si el mensaje contenía la palabra suelta
`persona`. `"es para otra persona"` o `"soy la persona que llamó ayer"` marcaban la
conversación `NEEDS_HUMAN` sin que nadie lo pidiera.

`persona` sale de las palabras sueltas. Quedan las familias `humano/humana/humanos`,
`operador/operadora`, `asesor/asesora`, `representante`, `atendente` (pt) y
`attendant`, más las frases de `HUMAN_ESCAPE_PHRASES` (`hablar con`, `falar com`,
`quiero una persona`, `atienda una persona`, `persona real`, `atención humana`, …).

## Dónde vive

Las reglas de matching se mudaron de `bot.service.ts` a
`apps/backend/src/bot/message-matching.ts`: funciones puras, sin DI ni DB, con su
propio spec. `BotService` e `IntentService` las comparten, así que la escalera del
bot y el clasificador determinista no pueden divergir.

Ojo con los tests de este módulo:
[[notas/2026-09-11-source-map-stack-overflow]].
