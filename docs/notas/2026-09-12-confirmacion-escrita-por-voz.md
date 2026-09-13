# 2026-09-12 — Por voz no se confirma ni se cancela una cita

Cierre del riesgo que quedó anotado en el PR 4 de M10
([[notas/2026-09-12-stt-cableado-notas-de-voz]]).

## El problema

La transcripción de una nota de voz entra al pipeline como si el paciente la
hubiera escrito. Eso es deseable para casi todo: si el bot entiende mal "quiero
agendar", el paciente lo corrige en el siguiente mensaje y no ha pasado nada.

Pero hay una frontera donde deja de ser recuperable. El parser determinista de
confirmaciones (`parseReminderReply`, `parseFlowConfirmReply`) reconoce `sí`,
`no`, `cancelar`, `confirmo`… y actúa: crea una cita, la confirma, o la cancela.
Y **"sí" es un golpe de voz de una sílaba**. El proveedor no nos devuelve
ninguna señal de confianza — `gpt-4o-mini-transcribe` da texto y ya — así que
no hay forma de distinguir un "sí" dicho de un "sí" inventado a partir de ruido,
de un "ajá" o del final de otra palabra.

El resultado de equivocarse no es un mensaje raro: es **una cita confirmada que
el paciente nunca pidió, o una cancelada que sí quería**. Y en el segundo caso
el turno queda libre y se lo lleva otro.

## La regla

> Se pide por escrito lo que **compromete o cancela**. La navegación pasa.

El bot repite lo que entendió y pide el mismo mensaje escrito:

> Entendí: «sí». Como viene de una nota de voz, prefiero asegurarme: ¿me lo
> escribes en un mensaje? Así no confirmo ni cancelo nada por error.

No cambia ningún estado: la FSM se queda donde estaba y el recordatorio sigue
pendiente, así que el siguiente mensaje escrito sigue el camino de siempre. El
coste de la regla es **un mensaje**; el coste de no tenerla es una cita.

La palabra va en negrita, y la que corresponde al idioma de la clínica
(`*SÍ*` / `*SIM*`, `*REAGENDAR*` / `*REMARCAR*`). No es cortesía: el eco se
persiste como `Message OUT` y `hasConfirmationContext` mira el último `OUT`
buscando `*SÍ*` para decidir si un "sí" suelto posterior es una confirmación.
Sin la palabra dentro, **el eco borraba el contexto que hacía válida la
respuesta que el propio eco había pedido**: el paciente hacía exactamente lo que
se le pidió y le salía el menú.

## A la segunda vez, una persona

Sin esto el guard es una trampa, y de las peores: el paciente que manda notas de
voz suele ser el que peor escribe —mayores, gente manejando, baja
alfabetización— y repetirle "escríbemelo" en bucle lo deja sin ningún camino
hacia su cita. Encima el guard hace `return` **antes** de la escalera de rescate
de la FSM (`replyNotUnderstood`, que a los 2 fallos ofrece el form web), así que
el bucle se comía justo el mecanismo que existía para sacar a la gente atascada.

A la segunda nota de voz seguida sobre lo mismo (ventana de 30 min en Redis) la
conversación pasa a `NEEDS_HUMAN` y lo atiende una persona, que puede resolver
por voz lo que el bot no debe resolver.

El contador es **fail-closed hacia la persona**: si Redis no responde no sabemos
si es la primera vez o la quinta, y dejar a alguien dando vueltas en un bucle es
peor que abrirle un hilo en la bandeja. Es lo contrario del throttle del aviso
de espera, que ante la duda calla — allí el riesgo es el ruido, aquí es que el
paciente se quede sin cita.

El criterio no es exactamente "muta una cita", que es donde empecé y se me
quedó corto. Es **"muta una cita o secuestra el estado de forma no obvia"**:

| Dónde | Guardado | Por qué |
|---|---|---|
| Recordatorio → `SÍ` / `CANCELAR` | sí | mutan la cita |
| Recordatorio → `REAGENDAR` | sí | no toca la cita, pero pone la FSM en `ASK_SLOT` y desde ahí el parser de recordatorios queda **inalcanzable**: la confirmación pendiente no se puede responder hasta decir "cancelar" |
| `Intent.REPROGRAMAR` (por el LLM) | sí | mismo secuestro por otra puerta, y con dos capas de incertidumbre en vez de una |
| `CONFIRM` → `SÍ` / `NO` / `CANCELAR` | sí | crean la cita o tiran el flujo |
| `CONFIRM` → `REAGENDAR` | **no** | vuelve a ofrecer horarios conservando los datos; el paciente todavía elige. Navegación |
| `isFlowAbort` en cualquier otro paso | sí | mismo efecto que `NO` en `CONFIRM`. Que no haya cita todavía no lo hace gratis: pierde servicio, profesional y horario ya elegidos |
| `AWAITING_NPS_SCORE` | sí | `recordFeedback` es create-once: un "cinco" mal transcrito queda como la nota **permanente** de esa visita y el paciente ya no puede corregirla. Más irreversible que una cita, que al menos se reagenda |
| `NEEDS_HUMAN` + `CANCELAR` | sí, pero **sin eco** | ahí el bot está callado a propósito; ver abajo |
| `isHumanEscape` ("quiero hablar con alguien") | **no** | hace `markNeedsHuman`, que borra `flowStep`/`flowData` a mitad de `CONFIRM`. Es un "cancela" que pasa sin guard, y a propósito: una petición de persona no se bloquea nunca, y el resultado es justamente que alguien mire |

## Dos sitios donde el guard tenía que comportarse distinto

**En `NEEDS_HUMAN` no se ecoa.** El bot está callado ahí a propósito, y el aviso
de "ya avisé al equipo" va throttleado a 4 h precisamente porque quien espera
escribe varias veces. Un eco por cada nota de voz se saltaría ese throttle: tres
audios seguidos, tres respuestas de un bot que se supone mudo. Se cae al aviso
normal y quien atienda lee el "cancelar" en la bandeja — que es lo bueno de ese
estado: ya viene alguien.

**En el camino del recordatorio, el guard va DEBAJO de `hasConfirmationContext`,
no encima.** Puesto arriba, un "ok, entonces nos vemos el martes" dicho por voz
recibía "¿me lo escribes?" cuando ese mensaje no iba a confirmar nada — fricción
por un riesgo inexistente. Sólo se repregunta lo que de verdad iba a mutar.

## Por qué un parámetro y no el contexto del turno

`recordBotTurn({ inputKind })` ya lleva el dato, y era tentador leerlo desde
`BotService` sin tocar firmas. No: ese contexto es de **observabilidad** y es un
no-op fuera de un turno a propósito (ver `bot-turn-context.ts`). Un guard de
seguridad colgado de él se apagaría en silencio en cualquier camino que no abra
el turno — tests, un replay, un camino futuro.

`handleIncoming({ inputKind })` es un parámetro explícito y su **ausencia
significa "texto escrito"**, que es el default seguro. Si alguien añade un
camino nuevo y se olvida de pasarlo, el bot pide confirmación de más; nunca de
menos.

## El eco es la única ruta por la que el paciente habla con voz de bot

`askWrittenConfirmation` repite lo que el paciente dijo, y eso se persiste como
`Message OUT`. `buildConversationContext` reinyecta los `OUT` al clasificador y
al RAG etiquetados como **`Asistente:`**. `IntentService` trata el texto del
paciente como no confiable a propósito; esta ruta lo lavaría y lo promovería a
la voz del bot. Por eso el eco va saneado: fuera caracteres de control y marcado
(`*`, `_`, backticks), saltos de línea colapsados y corte a 160 con puntos
suspensivos.

## Lo que esto no resuelve

Un paciente puede decir "sí" por voz, recibir la repregunta y escribir "sí" sin
haber entendido lo que confirmaba. El guard protege contra **la transcripción
equivocada**, no contra la desatención — para eso está el resumen de la cita que
el paso `CONFIRM` ya manda antes de pedir el sí.
