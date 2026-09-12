# 2026-09-12 — Cota diaria de transcripciones: por qué no bastaba el rate-limit

S38, primera tanda. Seguimiento que dejó abierto el cableado de M10
([[notas/2026-09-12-stt-cableado-notas-de-voz]]).

## El rate-limit del ADR 0007 no sirve para esto, y es a propósito

`withinBotRateLimit` es **fail-open**: con Redis caído deja pasar todo. Es la
decisión correcta para lo que protege — el coste de bloquear a un paciente por
un blip de Redis es peor que el de una llamada de más al LLM.

Con las notas de voz el signo del error cambia:

- una llamada de más se paga en **dinero**, por minuto de audio;
- y cada llamada manda **la voz de un paciente** fuera del perímetro.

Además el techo que dejaba el ADR 0007 —500 mensajes/h por clínica— son unas
12.000 transcripciones al día por clínica. Eso no es un techo, es el cielo.

## La cota

`stt:quota:{clinicId}:{YYYY-MM-DD}` en Redis, TTL de 48 h, límite por
`STT_DAILY_LIMIT` (default 200, suficiente para el piloto).

Tres decisiones que no se ven leyendo el código:

**El día es el de la clínica, no el del proceso.** El backend corre en UTC; una
clínica en Caracas vería su cota reiniciarse a las 20:00 hora local, en plena
tarde de consulta. Luxon con la TZ de la clínica, como todo lo que alguien lee.

**Fail-closed**, al revés que el rate-limit. Si no se puede contar, no se
transcribe. El paciente no se queda sin atención: cae al camino de siempre, el
aviso de "solo puedo leer mensajes de texto", que ya deriva a una persona si
insiste con audios.

**Leer y apuntar están separados.** `withinSttBudget` solo lee; `consumeSttBudget`
apunta, y se llama **después** de encolar. Entre una cosa y otra todavía puede
aparecer un motivo para no mandar el audio —que la conversación la haya tomado
una persona— y cobrar por lo que no se transcribió haría que la cota mintiera
justo cuando importa. La carrera que eso abre (dos webhooks leyendo el mismo
valor) puede pasarse del límite por uno o dos: da igual, esto es un tope de
gasto, no contabilidad.

## Qué ve el paciente y qué ve la clínica

El paciente recibe exactamente lo de antes de M10. **No se le deriva de entrada
a una persona**, aunque era lo primero que se propuso: quien puede escribir
sigue siendo atendido por el bot sin ocupar a nadie, y la bandeja no se llena
justo el día en que algo se disparó. Quien insista con audios acaba derivado
igual, por la racha de adjuntos que ya existía.

La clínica lo ve en el panel: el evento `bot.turn` lleva
`reasonCode: 'stt-sin-presupuesto'`. Sin eso, quedarse sin cota es invisible —
se ve una caída de transcripciones y ninguna explicación.

## Un env inválido no apaga el feature en silencio

`STT_DAILY_LIMIT=doscientos` daría `NaN`, y un `!limite` lo leería como cero:
transcripción apagada para todas las clínicas, con pinta de bug del feature en
vez de errata de configuración. Se avisa y se usa el default. Un `0` explícito
sí apaga, porque eso sí es una decisión.
