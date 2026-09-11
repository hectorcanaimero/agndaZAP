# 2026-09-11 — `Feedback` admitía filas cruzadas entre clínicas

Nota de **S4** del [[analisis/2026-09-11-chatbot-analisis-tecnico]].

**El agujero.** `Feedback` tiene **FKs separadas** a `Clinic` y a `Appointment`:

```prisma
clinicId      String
clinic        Clinic   @relation(...)
appointmentId String   @unique
appointment   Appointment @relation(...)
```

Nada en la base obliga a que `Feedback.clinicId` sea el mismo que
`Feedback.appointment.clinicId`. `FollowUpsService.recordFeedback` recibía los
dos por separado y los escribía sin comprobar que fueran juntos.

**Cómo se llega ahí.** El `appointmentId` no viene de la request: sale de
`Conversation.flowData`, una columna JSON **durable** que escribe
`follow-ups.processor.ts` (`{ feedbackAppointmentId }`) y que el bot lee
minutos u horas después. El `clinicId` sale de la conversación. Cualquier cosa
que deje un `flowData` cruzado —un dato viejo, una conversación reasignada, un
bug futuro que copie `flowData`, una edición manual en la base— produce la
escritura cruzada sin que nadie lo note.

**Por qué importa, en dos frentes.**

1. **Fuga de PII de salud entre tenants.** El panel agrega feedback por
   `clinicId` (`@@index([clinicId, respondedAt])`), así que la clínica A vería
   el score y el **comentario en texto libre** de un paciente de la clínica B.
2. **Envenenamiento silencioso.** Como `appointmentId` es `@unique`, esa fila
   cruzada ocupa el hueco: la clínica B no podrá registrar nunca el feedback
   real de esa cita, y el paciente recibirá un "ya respondiste" que es mentira.

## El arreglo

`recordFeedback` comprueba la pertenencia **antes** de escribir, con el tenant
dentro del `where` (nunca `findUnique` por id y comparar después):

```ts
const appt = await this.prisma.appointment.findFirst({
  where: { id: appointmentId, clinicId },
  select: { id: true },
});
```

**Devuelve `created: false` en vez de lanzar.** El caller es el webhook del
bot: una excepción ahí es un 500 que WAHA reintenta en bucle sobre un
`flowData` que no se va a arreglar solo. El paciente ve el mismo cierre amable
que ante un feedback duplicado, y el cruce queda en un log de nivel `error`
(`clinicId` y `appointmentId` son cuids, no PII).

La ventana entre comprobar y escribir es inofensiva: una cita no cambia de
clínica en toda su vida.

## El segundo agujero, peor: el comentario

`bot.service.ts` (`handleAwaitingNpsComment`) guarda el comentario con:

```ts
await this.prisma.feedback.update({
  where: { appointmentId: apptId },   // ← sin clinicId
  data: { comment: ... },
});
```

Es peor que el anterior porque **sobrescribe** texto escrito por un paciente de
otra clínica, en vez de solo añadir una fila. El panel lo sirve junto a
`patientName`, `professionalName` y `serviceName`, así que un `CLINIC_ADMIN`
vería la queja de salud de un paciente ajeno atribuida a un paciente propio.

> **Ojo con la razón por la que preferimos `updateMany`**, porque la primera
> versión de esta nota la tenía mal: `update` **sí** admite el filtro. Con
> `extendedWhereUnique` (GA desde Prisma 5.0, aquí estamos en 5.20),
> `update({ where: { appointmentId, clinicId } })` compila y filtra. La razón
> real es qué pasa cuando no hay match: `update` lanza **P2025**, que sube al
> webhook como un 500 y dispara el bucle de reintentos de WAHA. `updateMany`
> devuelve `count: 0` y nos deja decidir. Dejar escrita una justificación falsa
> es peor que no escribir ninguna: invita a que alguien la refute y revierta el
> cambio por el motivo equivocado.

```ts
const { count } = await this.prisma.feedback.updateMany({
  where: { appointmentId, clinicId },
  data: { comment: comment.trim().slice(0, 1000) },
});
```

Eso vive ahora en `FollowUpsService.recordComment`. **Está sin cablear**:
`bot.service.ts` es de otra sesión durante el P1, así que el método existe para
que el cambio allí sea de una línea. Mientras no se cablee, el agujero del
comentario sigue abierto.

> **Regla para este repo**: cuando una tabla tiene `clinicId` propio *y* una FK
> a otra entidad con `clinicId`, el `clinicId` de la fila no es una garantía,
> es una copia. Hay que validar que ambos coinciden en cada escritura, o el
> aislamiento multi-tenant depende de que ningún camino se equivoque nunca.

## El arreglo estructural, pendiente

Validar en el servicio es defensa en profundidad, pero la clase entera de bug
se elimina haciendo que la base lo impida, con una FK compuesta:

```prisma
model Appointment {
  @@unique([clinicId, id])
}
model Feedback {
  appointment Appointment @relation(
    fields: [clinicId, appointmentId], references: [clinicId, id], onDelete: Cascade
  )
}
```

Requiere migración, así que va aparte y merece su propio ADR. El mismo patrón
aplica a cualquier otra tabla del esquema que copie `clinicId` junto a una FK.

**Amplificación que lo hace urgente**: `feedback.controller.ts` filtra por
`Feedback.clinicId`, que es correcto para la columna, pero el `include` sigue
`appointmentId` hasta `patient.name`, `professional.name` y `service.name`
**sin volver a comprobar el tenant**. Una sola fila cruzada convierte una
corrupción de datos en una fuga de PII de salud.

## Verificación de datos existentes

El parche impide crear filas nuevas, no limpia las viejas. Antes de dar el
hallazgo por cerrado, correr una vez contra producción:

```sql
SELECT f.id, f."clinicId" AS feedback_clinic, a."clinicId" AS appointment_clinic
FROM "Feedback" f
JOIN "Appointment" a ON a.id = f."appointmentId"
WHERE f."clinicId" <> a."clinicId";
```

Cero filas = el arreglo es preventivo y no hay que remediar datos.

Relacionado: [[adr/0012-feedback-post-atencion]], [[notas/2026-09-11-waha-mensajes-sin-texto]].
