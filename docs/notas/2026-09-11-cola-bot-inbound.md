# 2026-09-11 — Cola `bot-inbound`: los gotchas

Decisión y consecuencias en [[adr/0021-cola-bot-inbound]]. Aquí, lo que costó
sangre.

## BullMQ rechaza un `jobId` con `:`

El plan era natural: usar la clave de dedup (`waha:evt:{session}:{digest}`)
como `jobId`, y que BullMQ descartara el duplicado por su cuenta. **No
compila en runtime**: `Job.addJob` valida

```js
if (this.opts?.jobId.includes(':') && this.opts?.jobId.split(':').length !== 3)
    throw new Error('Custom Id cannot contain :');
```

Cuatro segmentos → lanza. Y lanza en **todos** los mensajes de texto, porque
todos los eventos reales de WAHA traen `payload.id`. El efecto encadenado era el
peor posible: `add` lanza → 500 al webhook → WAHA reintenta contra un fallo
determinista → agota reintentos → el mensaje se pierde. Con el health check en
verde, además, porque el job nunca llegaba a existir.

El `jobId` ahora es `waha-evt-{digest}`, sin dos puntos, con la `session`
**dentro del hash** (el id tiene que seguir acotado al tenant o una clínica
podría suprimir el mensaje de otra).

> No usar la variante de tres segmentos, que sí pasa la validación: es un
> resquicio de compat con repeatables viejos que el propio BullMQ marca para
> eliminar, y se rompería igual si un `wahaSession` trajera un `:`.

**Por qué no lo vieron los tests.** La `Queue` está mockeada en todos los specs,
así que el test que comprobaba el `jobId` sólo verificaba el string que le
pasábamos al mock, nunca que BullMQ lo aceptara. Ahora hay un test que asserta
el formato (`no contiene ':'`), pero la lección es más general: **un mock nunca
valida el contrato de la librería**. Para eso hace falta un test de integración
contra un Redis real, que todavía no existe.

## Retención por edad, no por cantidad

`removeOnComplete: 1000` suena acotado y no lo es: en una clínica de ~100
mensajes/día son diez días del texto de todos los pacientes guardado en Redis.
El job lleva teléfono y mensaje, o sea datos de salud, y Redis no tiene el
cifrado en reposo ni el TLS que el ADR 0004 da por supuestos para Postgres.
Con `{ age, count }` el dato caduca solo.

Relacionado: `parseRedis()` **descartaba en silencio** el usuario, la
contraseña y el esquema `rediss://` del `REDIS_URL`. Daba igual mientras en
Redis sólo hubiera contadores e IDs; con esta cola deja de dar igual.

## La PII se escapa por el mensaje del error, no por `job.data`

Excluir `job.data` del reporte a Sentry es la mitad del trabajo. La otra mitad:
`handleIncoming` hace `prisma.message.create({ body: text })`, y los errores de
validación de Prisma **imprimen los argumentos de la invocación**, con el `body`
dentro. Ese string acabaría a la vez en Redis (`failedReason` del job), en
Axiom y en Sentry — y el redactor de pino no lo cubre, porque opera sobre paths
de objetos, no sobre texto ya interpolado.

De ahí `safeErrorLabel`: los errores de Prisma se reducen a `nombre:código`, sin
mensaje. También se sanea el stack que se manda a Sentry, porque su primera
línea repite el mensaje.

## El health check tiene que mirar la antigüedad, no la profundidad

Un umbral de "más de 50 esperando" no detecta lo que dice detectar: una clínica
piloto con 5-10 mensajes/hora tarda **días** en juntar 51 pendientes, así que un
worker muerto pasaría desapercibido justo en el escenario en el que estamos hoy.
La señal buena es cuánto lleva esperando el más viejo.

Dos cosas más de ese check:

- **Un fallo suelto no tumba el `ok`.** El endpoint es público; si un mensaje
  concreto revienta el bot, bastaría repetirlo para mantener el backend
  "degradado" una hora entera, gratis. Se cuenta y se loguea, pero no degrada.
- **Los fallidos se cuentan con `ZCOUNT`**, no con `getFailed()`: éste hace un
  `HGETALL` por job y traería cientos de mensajes de pacientes a memoria **en
  cada ping anónimo a `/api/health`**.

## El orden de los mensajes ya no está garantizado por construcción

`concurrency: 1` se fija explícito (hoy coincide con el default, pero subirlo
"para ir más rápido" rompería la FSM sin ninguna señal). Aun así, **un reintento
reordena**: el job que falla vuelve al final de la cola, así que el "2" del
paciente puede procesarse antes que su "1" y la FSM aplicar cada respuesta al
paso equivocado. La defensa real sería un compare-and-set en la transición
(`updateMany({ where: { id, flowStep: pasoEsperado } })`), y está anotada como
pendiente en el ADR.

Relacionado: [[notas/2026-09-11-waha-mensajes-sin-texto]], [[adr/0007-rate-limit-bot]].
