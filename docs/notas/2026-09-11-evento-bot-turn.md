# 2026-09-11 — Evento `bot.turn`: lo que costó que fuera útil y seguro

Observabilidad del bot (M9-a). El dashboard que lo consume va aparte (M9-b).

## Quién emite, y por qué no `BotService`

Una línea estructurada por turno, emitida por **quien envuelve el turno**: el
processor de `bot-inbound`, o el webhook para los caminos que no llegan al bot
(adjuntos, descartes). Es el único sitio donde se sabe la latencia real y donde
se emite pase lo que pase, incluido cuando el turno revienta.

Los datos que sólo se conocen dentro del bot —intención, si la resolvió una
regla o el LLM, cómo fue la búsqueda del RAG— viajan por un `AsyncLocalStorage`
(`bot-turn-context.ts`, mismo mecanismo que `requestContext`) que `BotService`
va rellenando. Si cada parte logueara lo suyo, un turno saldría repartido en
cinco líneas sin forma de correlacionarlas y ninguna diría cuánto tardó.

## El seudónimo del teléfono era reversible

`hashChatId` era `sha256(chatId)` truncado. **El número de bits nunca fue el
punto: el problema era que no había secreto.** El espacio de teléfonos es
enumerable, así que el "hash" era el teléfono escrito de otra forma; el auditor
lo demostró recuperando un número en 4 segundos, monohilo y sin GPU.

Mientras eso aparecía sólo en una línea `warn` de rate-limit era una arista
fea. Este evento lo ponía en **todos los turnos**, con destino un procesador
externo: un registro continuo y reversible de "el teléfono X habló con la
clínica de salud Y a la hora T". Eso es dato de salud.

Ahora es un HMAC con `LOG_HASH_SECRET` y **con el `clinicId` dentro del
preimagen**. Lo segundo importa tanto como lo primero: sin ello, el mismo
paciente producía el mismo seudónimo en clínicas distintas y un solo filtro lo
correlacionaba entre tenants — justo el enlace que el aislamiento multi-tenant
existe para impedir.

> ⚠️ **`LOG_HASH_SECRET` es obligatoria en producción** (`validateProdEnv`). Sin
> ella el backend no arranca. Hay que crearla en Coolify **antes** de desplegar.

## El campo más útil salía como `[REDACTED]`

El motivo del turno se llamaba `reason`, y `reason` está en
`PII_REDACT_PATHS` — por el motivo de consulta del paciente, con razón.
`nestjs-pino` vuelca el objeto del log en la **raíz** del entry, que es justo
donde pega el redactor. O sea: en producción, `rate-limit`,
`clinica-no-activa` y el motivo de cualquier error salían todos como
`[REDACTED]`.

Y los tests no podían verlo, porque espían el logger de Nest **antes** de que
pino redacte. Verde en CI, ciego en el destino real.

Hay dos lecciones, y la segunda es la que vale:

1. Al nombrar campos de un evento estructurado, comprobarlos contra
   `PII_REDACT_PATHS`. Ahora se llama `reasonCode`.
2. **Renombrarlo sin más habría convertido un bug en una fuga.** El valor era
   `safeErrorLabel(error)`, o sea el mensaje de la excepción recortado a 200
   caracteres — y los errores de `JSON.parse` incluyen un trozo de la entrada,
   que aquí es lo que escribió el paciente. La redacción accidental era lo
   único que lo tapaba. Por eso `reasonCode` es ahora un **conjunto cerrado**
   de etiquetas, no texto libre: para agrupar en un panel hace falta una
   etiqueta estable, y el detalle del error ya se loguea aparte, saneado.

Queda un test en `pii-redactor.spec.ts` que recorre el evento entero contra el
redactor real, para que el próximo campo que alguien añada se cace ahí.

## Los contadores contaban reintentos

BullMQ reintenta hasta tres veces. Un mensaje que falla dos y acierta a la
tercera sumaba **3 turnos y 2 errores por un solo mensaje del paciente**: el
panel de la clínica mintiendo sobre su propio volumen. Los contadores sólo
cuentan el primer intento; el evento sí se emite en todos, con `attempt`, que es
lo que hace falta para depurar.

## Otros dos que habrían mentido en silencio

- **El día del contador iba en UTC.** En Caracas (UTC-4), todo lo que entra
  entre las 20:00 y medianoche caía en el bucket del día siguiente: el "hoy" del
  panel saldría a cero justo en la franja de tarde-noche. Ahora va en la zona de
  la clínica con Luxon, como manda el CLAUDE.md — y sin query extra, porque los
  dos emisores ya consultaban la clínica.
- **`pipeline.exec()` de ioredis no rechaza por errores de comandos sueltos**:
  los devuelve dentro del array. Una clave con el tipo equivocado habría hecho
  fallar todos los `HINCRBY` sin que nadie se enterara, y el dashboard habría
  mostrado ceros para siempre.

## Contrato para quien consuma esto (M9-b)

- **`turns` incluye descartados y adjuntos.** "Turnos atendidos" es
  `outcome:ok`.
- **No hay latencia en los contadores.** Es una distribución y un contador no la
  representa; para eso está el evento.
- **`latencyMs` se omite cuando el turno no llegó a correr**, en vez de mandar
  0: un cero se promedia y hunde la media.
- En una clínica de muy bajo volumen, un día con un solo turno hace que el
  desglose por intención identifique la intención de ese único paciente. Si los
  valores de intención se vuelven clínicamente específicos, habrá que suprimir
  el desglose por debajo de un umbral.

Relacionado: [[adr/0021-cola-bot-inbound]], [[adr/0007-rate-limit-bot]],
[[notas/2026-09-11-cola-bot-inbound]].
