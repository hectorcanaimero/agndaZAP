# 2026-09-11 — Actividad del bot en el panel: criterios de agregación

Bloque "Asistente de WhatsApp" del dashboard (M9-b). Los datos los escribe el
bot en Redis; el evento y los contadores están en
[[notas/2026-09-11-evento-bot-turn]].

## La regla que ordena todo: un `null` no es un 0

Los contadores los escribe el bot al vuelo, así que para cada métrica hay tres
estados, no dos: **no se mide**, **se midió y salió cero**, y **hay un valor**.
En un panel los dos primeros se ven igual, y significan lo contrario.

El caso concreto que casi se cuela: `handoffRate` se calculaba como
`handoff / turns`, y **nadie escribe todavía el contador `handoff`** (lo
cableará la sesión dueña de `bot.service.ts`). En cuanto hubiera un turno, la
división daba 0 y el panel afirmaba **"Derivados a una persona: 0%"** — o sea,
"el bot lo resuelve todo solo". Justo la afirmación que la nota de M9-a decía
querer evitar, escrita en el mismo PR que la escribía.

Por eso `readBotStats` devuelve `number | null` en los campos que pueden no
estar cableados, y `null` significa "ni una sola vez en todo el periodo". Un
`handoff: 0` explícito sí se muestra como 0%, porque eso sí es un dato.

## Por qué el motivo de "no hay desglose" viaja en el payload

El panel tenía una sola frase para explicar la ausencia del desglose por
intención: *"aparece a partir de 10 mensajes"*. Pero hay dos causas, y con 20
turnos y ninguna intención anotada esa frase es **una mentira que el propio
usuario puede comprobar**. El backend manda `breakdown: 'ok' |
'not-measured' | 'below-threshold'` y el front elige el texto.

## El umbral de privacidad, y qué queda fuera de él

Con menos de 10 turnos en el periodo no se muestran **desgloses ni tasas**: con
un turno, "100% derivados a una persona" dice que a *esa* persona la atendió un
humano, y un desglose por intención dice qué quería *ese* paciente.

Los **conteos brutos** (turnos, atendidos, adjuntos) sí se muestran siempre, y
la distinción es deliberada: el volumen es actividad del propio canal de la
clínica, que ya ve mensaje a mensaje en su WhatsApp. Lo que el umbral protege es
la **clasificación que hicimos nosotros** sobre esos mensajes, que es
información nueva sobre el paciente y no algo que la clínica ya tuviera.

`nullAnswerRate` usa su propio denominador: las consultas al RAG, no los turnos.
Dividir entre turnos haría que una clínica con mucho agendamiento y poca
consulta pareciera tener un RAG buenísimo. Y su umbral también es sobre el RAG.

## Citas por origen: `createdAt`, no `startAt`

La primera versión reutilizaba el fetch de citas de 30 días que el dashboard ya
hacía. Ese fetch filtra por `startAt` en el pasado, así que respondía "las citas
que el asistente trajo y **ya se celebraron**" — dejando fuera justo las que el
bot agendó esta semana para la siguiente. En una clínica que agenda con dos
semanas de antelación, la subcuenta es sistemática.

La pregunta que la clínica le hace a este bloque es *"¿cuántas citas me trajo el
asistente?"*, así que va por `createdAt` en la misma ventana que los contadores,
aunque cueste una query más. Reutilizar el fetch era una optimización que
compraba el dato equivocado.

## Dos detalles operativos

- **La TZ viaja en el job**, no se relee en el worker. Si el worker tuviera que
  consultarla y la base estuviera caída, el contador del error —el que avisa del
  problema— se escribiría con la zona del proceso (UTC) y caería en el día
  equivocado, fuera de la ventana de lectura.
- **Hay un tope de 300 ms** para leer los contadores. El `try/catch` cubre
  "Redis caído", pero el modo que duele es "Redis vivo y lento": el cliente no
  tiene `commandTimeout`, así que sin la carrera un Redis colgado se llevaba por
  delante todo el dashboard, que es lo que la clínica abre por la mañana.

Relacionado: [[notas/2026-09-11-evento-bot-turn]], [[adr/0021-cola-bot-inbound]].
