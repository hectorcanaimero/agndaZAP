---
status: accepted
date: 2026-09-11
tags: [multi-tenant, seguridad, prisma, base-de-datos]
---

# ADR 0021 — FKs compuestas para que el aislamiento entre clínicas no dependa del código

## Contexto

La regla del proyecto es "`clinicId` en toda entidad y validar el tenant en cada query"
([[CLAUDE]]). Funciona, pero su cumplimiento depende **enteramente de la disciplina de cada
caller**: la base de datos no sabe nada de tenants y acepta encantada una fila cuyo `clinicId`
no coincide con el de la entidad que referencia.

`Feedback` lo dejó claro. Tenía dos FKs sueltas:

```prisma
clinicId      String
clinic        Clinic      @relation(fields: [clinicId], references: [id])
appointmentId String      @unique
appointment   Appointment @relation(fields: [appointmentId], references: [id])
```

Nada impedía un `Feedback` con el `clinicId` de la clínica A apuntando a una cita de la B.
`FollowUpsService.recordFeedback` escribía el par sin comprobarlo (arreglado en S4), y el
`include` del panel —que trae **nombre del paciente, profesional y servicio de la cita**—
habría servido datos de otra clínica, porque su `where` solo filtraba por `Feedback.clinicId`.

El chequeo en `recordFeedback` cierra el camino conocido. No cierra el siguiente.

## Decisión

Donde una tabla copia `clinicId` **y además** referencia a otra entidad con `clinicId`, la
referencia pasa a ser una **FK compuesta** que incluye el tenant:

```prisma
// En Appointment: habilita que otros la referencien por (clinicId, id).
@@unique([clinicId, id])

// En Feedback: la cita referenciada tiene que ser de ESTA clínica.
appointment Appointment @relation(
  fields:     [clinicId, appointmentId],
  references: [clinicId, id],
  onDelete: Cascade
)
```

A partir de ahí, un par cruzado no es un bug que haya que recordar evitar: es un `INSERT` que
Postgres rechaza. La disciplina sigue siendo buena idea; deja de ser la única defensa.

Aplicado en este ADR **solo a `Feedback`**, que es donde el agujero estaba abierto y sin
validar. El resto se deja documentado abajo con su estado real.

## El barrido completo

Seis tablas copian `clinicId` junto a una FK hacia otra entidad con `clinicId`:

| Tabla | Referencia a | ¿Validado en código? | FK compuesta |
|---|---|---|---|
| `Feedback` | `Appointment` | sí, desde S4 | **sí, este ADR** |
| `BusinessHour` | `Professional` | sí — `assertProfessionalInClinic` | pendiente |
| `TimeOff` | `Professional` | sí — `assertProfessionalInClinic` | pendiente |
| `Appointment` | `Service`, `Professional` | sí — `createAppointment` los carga por `clinicId` | pendiente |
| `Appointment` | `Patient` | sí — upsert por `(clinicId, phone)` | pendiente |
| `Appointment` | `Conversation` | **no** | pendiente |
| `Conversation` | `Patient` | sí — S5 lo guarda explícitamente | pendiente |
| `User` | `Professional` | no verificado | pendiente |

Los "pendiente" no son agujeros abiertos hoy: en casi todos hay una validación en el camino de
escritura. Son **defensa en profundidad que falta**, y cada uno necesita comprobar antes si la
base de producción ya tiene filas que violen el invariante — por eso no van en este PR.

El único sin validación de código que merece mirarse pronto es `Appointment.conversationId`:
`createAppointment` lo persiste cuando `source === 'BOT_WEB'` sin comprobar que la conversación
sea de la misma clínica. Hoy no es alcanzable (el `conversationId` sale de un token que ya
valida el slug), pero es exactamente la forma del bug de `Feedback` antes de S4.

## Consecuencias

**A favor**
- El aislamiento de `Feedback` deja de depender de que cada caller se acuerde.
- La migración **falla ruidosamente** si ya hay filas cruzadas, con la query exacta para
  revisarlas. Es lo que queremos: si existen, son datos cruzados entre tenants y hay que
  mirarlos a mano, no borrarlos desde una migración.

**En contra / a tener en cuenta**
- Prisma exige `@@unique([clinicId, appointmentId])` en el lado definidor de una relación 1-1.
  Es redundante con `appointmentId @unique` —que es la restricción de negocio de verdad, un
  feedback por cita— pero el validador no lo acepta de otra forma.
- `@@unique([clinicId, id])` en `Appointment` es un índice extra sobre una tabla que crece. El
  coste es bajo y a cambio quita una clase entera de fallo.
- Cambiar el `clinicId` de una cita ahora arrastra sus feedbacks (`ON UPDATE CASCADE`). No hay
  ningún flujo que lo haga, y si lo hubiera, arrastrarlos es lo correcto.

## Relacionado
[[adr/0004-pii-y-compliance]] · [[adr/0012-feedback-post-atencion]] ·
[[adr/0014-superadmin-como-operador-saas]] · [[notas/2026-09-11-offboarding-clinic-status]] ·
[[SPEC]]
