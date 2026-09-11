---
status: accepted
date: 2026-09-11
tags: [scheduling, whatsapp, web, seguridad, metricas, multi-tenant]
---

# ADR 0020 — Gestión de cita por link (cancelar y reagendar sin escribir)

## Contexto

Hoy un paciente que quiere cambiar o cancelar su cita solo puede hacerlo escribiéndole al
bot. Eso obliga al bot a resolver bien la intención, encontrar la cita correcta y conducir
una FSM de reagendamiento por chat — tres cosas que fallan seguido y que, cuando fallan,
terminan en el peor resultado posible para el producto: el paciente no cancela, no avisa, y
simplemente no aparece. Un no-show que el sistema podría haber evitado.

El análisis del bot ([[analisis/2026-09-11-chatbot-analisis-tecnico]], ítem M2) concluyó que
**el link debe ser el camino principal** para gestionar una cita, y el chat la alternativa.
Un link no depende de que un LLM acierte la intención.

Ya existe el precedente de [[adr/0018-scheduling-link-wa]]: un token efímero que lleva al
paciente del chat a la web para *crear* una cita. Este ADR extiende la idea a *gestionarla*.

## Decisión

Un segundo tipo de token, de **gestión**, que da acceso a una cita concreta ya existente, y
tres endpoints públicos para verla, cancelarla y moverla.

URL: `{WEB_BASE_URL}/{locale}/agendar/{slug}/cita?t={token}`

### El token

- Vive en Redis bajo `sched:manage:`, separado del de agendamiento, con `kind: 'manage'` en
  el payload `{ appointmentId, clinicId, clinicSlug, phone }`.
- 24 bytes de `randomBytes` → ~192 bits. No es adivinable ni iterable.
- **No se consume al leerlo**, a diferencia del de agendamiento. El paciente abre el link,
  mira su cita, cierra, vuelve al día siguiente. Consumirlo en el `GET` haría que recargar
  la página rompiera el link, que es justo lo contrario de lo que se busca.
- Se invalida al cancelar (la cita ya no es gestionable) y al reagendar (se emite uno nuevo).
- **TTL derivado de `startAt`**, con suelo de 30 min y techo de 30 días. Después del inicio
  ya no se puede ni cancelar ni mover, así que mantenerlo vivo solo sería superficie de
  ataque. El suelo evita que una cita para dentro de diez minutos nazca con un link muerto;
  el techo evita que una cita a seis meses deje un token válido medio año.
- Se emite en varios sitios (respuesta del POST público, recordatorios, confirmación del
  bot), así que puede haber varios vivos por cita. Es intencional: invalidar los anteriores
  exigiría un índice `appointmentId → tokens` y no compra nada, porque todos apuntan a la
  misma cita y caducan solos.

### Los endpoints

Bajo `/api/public/clinics/:slug`, sin auth, rate-limit 10/min:

| Endpoint | Qué hace |
|---|---|
| `GET /appointments/manage/:token` | Datos de la cita + `canCancel` / `canReschedule`. |
| `POST /appointments/manage/:token/cancel` | Cancela y apaga recordatorios. |
| `POST /appointments/manage/:token/reschedule` | Mueve el horario. Emite token nuevo. |

`canCancel = canReschedule = status ∈ {PENDIENTE, CONFIRMADA, EN_RIESGO} && startAt > now`,
en `SchedulingService.isPatientMutable` para que la regla que ve la web y la que valida el
servidor no puedan divergir. El servidor **siempre** re-valida contra la DB: entre que se
pintó la página y se pulsó el botón, la clínica pudo marcar la cita como ATENDIDA.

### Reagendar mueve la cita in-place

El contrato original pedía crear una cita nueva y cancelar la vieja, para dejar traza del
movimiento. **Se descartó**: el no-show rate se calcula sobre
`NO_SHOW / (ATENDIDA + NO_SHOW + CANCELADA)` (`admin-metrics.service.ts`), así que una fila
`CANCELADA` por cada reagendamiento inflaría el denominador y **diluiría hacia abajo justo
la métrica que el producto promete mejorar**. Cuantos más pacientes movieran su cita en vez
de faltar —que es exactamente el comportamiento que queremos provocar— mejor se vería el
número, por razones artificiales. El dashboard de la clínica tendría el mismo problema al
revés: `todayCanceled` diría "3 cancelaciones hoy" sin que nadie hubiera cancelado.

Así que se reutiliza `SchedulingService.rescheduleAppointment`, que ya existía para el panel
y mueve la cita conservando el id. La traza de reagendamientos, que sí es una señal legítima
de riesgo de no-show, se hará con campos propios (`rescheduleCount`, `lastRescheduledAt`) que
no tocan el enum de estados ni, por tanto, las métricas.

## Seguridad

- **El `clinicId` sale del token, no del slug de la URL.** Aunque un id de cita se filtrara,
  sin el token de esa clínica no se resuelve nada. Además el `clinicSlug` guardado tiene que
  coincidir con el `:slug` de la URL, igual que en el ADR 0018.
- **Todos los fallos devuelven el mismo 404 con el mismo texto**: token inexistente,
  expirado, de otra clínica, o cita borrada. Distinguirlos le diría a quien prueba tokens si
  acertó el formato o la clínica.
- **El rate-limit va por `scope:slug:ip`, no por token+ip** como decía el contrato original.
  Limitar por token lo haría inútil para su único propósito: cada token probado estrenaría su
  propio cupo, que es precisamente lo que necesita quien quiere iterar.
- **Del paciente solo sale el nombre.** El link puede acabar reenviado por WhatsApp o en el
  historial del navegador; el nombre basta para que reconozca su cita, el teléfono no aporta
  nada y sí es PII de salud ([[adr/0004-pii-y-compliance]]).
- **`patientCreated` nunca sale al borde público.** `createAppointment` pasa a devolver
  `{ appointment, patientCreated }` porque el bot lo necesita para decidir si puede ligar una
  Conversation a un Patient. Filtrarlo en la respuesta de creación diría si un teléfono ya
  era paciente de la clínica: un oráculo para enumerar pacientes probando números.

## Consecuencias

**A favor**
- El camino principal para cancelar o mover una cita deja de depender de que un LLM acierte.
- Cancelar es ahora más fácil que no aparecer, que es el incentivo correcto.
- El endpoint de creación devuelve `manageUrl`, así que `/gracias` puede ofrecer el link sin
  pedir nada más.

**En contra / deuda**
- Quien tenga el link tiene la cita. Es el mismo modelo del ADR 0018 y el habitual en links
  de gestión de reservas, pero conviene tenerlo escrito: no hay segundo factor.
- Varios tokens vivos por cita, aceptado arriba.
- `createAppointment` cambió de firma; todos los callers quedaron actualizados en este mismo
  cambio, pero cualquier caller nuevo tiene que recordar no filtrar `patientCreated`.
- Falta la traza de reagendamientos (S6) y el cableado del bot (M2-c), que mandará este link
  ante `REPROGRAMAR` y `CANCELAR`.

## Relacionado
[[adr/0018-scheduling-link-wa]] · [[adr/0004-pii-y-compliance]] ·
[[adr/0007-rate-limit-bot]] · [[adr/0003-rate-limit-casero-vs-throttler]] ·
[[analisis/2026-09-11-chatbot-analisis-tecnico]] · [[SPEC]]
