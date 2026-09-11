---
titulo: Los otros 9 pares del ADR 0022 — cuáles merecen FK compuesta
fecha: 2026-09-11
tags: [multi-tenant, seguridad, prisma, base-de-datos, exploracion]
---

# Revisión de los pares `clinicId` + FK restantes

Continuación de [[adr/0022-fk-compuestas-multi-tenant]], que aplicó la FK
compuesta solo a `Feedback → Appointment` y dejó el resto documentado. **Esta
nota no trae migración**: decide cuáles merecen el cambio y en qué orden.

## El criterio

Una FK compuesta convierte "hay que acordarse de validar el tenant" en "Postgres
lo rechaza". No es gratis: añade un índice único, hace la migración fallible si
ya hay datos cruzados, y no todas las relaciones lo necesitan por igual.

Los tres factores que uso, en orden de peso:

1. **¿Hay validación en el camino de escritura hoy?** Sin ella, es un agujero
   abierto y no deuda.
2. **¿Qué se filtra si el par se cruza?** No es lo mismo un horario de atención
   que el nombre y el teléfono de un paciente.
3. **¿Cuántos sitios escriben el par?** Uno solo es fácil de auditar; cinco no.

## Estado de la base

Comprobé los ocho pares contra la base de desarrollo: **cero filas cruzadas** en
todos. No prueba que producción esté limpia —son bases distintas y la de
desarrollo tiene poco volumen— pero sí que el invariante no está roto de forma
estructural. La query de comprobación, para correr contra producción antes de
cualquier migración:

```sql
select 'BusinessHour→Professional', count(*) from "BusinessHour" b
  join "Professional" p on p.id = b."professionalId" where b."clinicId" <> p."clinicId"
union all select 'TimeOff→Professional', count(*) from "TimeOff" t
  join "Professional" p on p.id = t."professionalId" where t."clinicId" <> p."clinicId"
union all select 'User→Professional', count(*) from "User" u
  join "Professional" p on p.id = u."professionalId" where u."clinicId" <> p."clinicId"
union all select 'Conversation→Patient', count(*) from "Conversation" c
  join "Patient" pa on pa.id = c."patientId" where c."clinicId" <> pa."clinicId"
union all select 'Appointment→Patient', count(*) from "Appointment" a
  join "Patient" pa on pa.id = a."patientId" where a."clinicId" <> pa."clinicId"
union all select 'Appointment→Service', count(*) from "Appointment" a
  join "Service" s on s.id = a."serviceId" where a."clinicId" <> s."clinicId"
union all select 'Appointment→Professional', count(*) from "Appointment" a
  join "Professional" p on p.id = a."professionalId" where a."clinicId" <> p."clinicId"
union all select 'Appointment→Conversation', count(*) from "Appointment" a
  join "Conversation" c on c.id = a."conversationId" where a."clinicId" <> c."clinicId";
```

## La recomendación

### Sí, y pronto — `Appointment → Patient`

Es el par que más expone. Una cita apuntando al paciente de otra clínica filtra
**nombre y teléfono** por todas las vistas del panel, la agenda, el feed iCal del
profesional y los recordatorios — que además **le mandarían un WhatsApp a esa
persona**. Es el único de la lista donde cruzar el par no solo muestra datos
ajenos, sino que contacta a alguien.

Hay validación (`createAppointment` hace upsert por `(clinicId, phone)`), pero es
un método largo que ya ha cambiado varias veces en dos días y que van a seguir
tocando M2-c y B5.

### Sí, en el mismo lote — `Appointment → Service` y `Appointment → Professional`

Van con el anterior porque comparten tabla y migración: un solo
`@@unique([clinicId, id])` en `Service` y otro en `Professional` cubren estos dos
y de paso habilitan los tres pares con `Professional` de más abajo. Filtran menos
(nombre de servicio, nombre de profesional) pero el coste marginal de incluirlos
es casi nulo.

### Sí, pero después — `Appointment → Conversation`

S22 ya le puso la validación de código que le faltaba, así que dejó de ser el
agujero abierto de la lista. Merece la FK igual, porque una cita atada a la
conversación de otra clínica deja que **ese chat gestione la cita de un
paciente ajeno**, pero ya no corre prisa.

### Sí, de propina — `Conversation → Patient`

Lo escribe hoy un solo sitio (el processor de follow-ups) más S5. Poco riesgo
actual, pero el `@@unique([clinicId, id])` en `Patient` ya estará puesto por el
primer lote, así que el coste es una línea.

### No por ahora — `BusinessHour → Professional` y `TimeOff → Professional`

Los dos tienen `assertProfessionalInClinic` en el camino de escritura, los
escriben endpoints del panel que no han cambiado en semanas, y lo que se filtra
es un horario de atención: cero PII. Es deuda real, pero es la de menor valor de
la lista.

### No, y conviene mirarlo aparte — `User → Professional`

`User.clinicId` es **nullable** porque el SUPERADMIN no pertenece a ninguna
clínica. Un `SUPERADMIN` con `professionalId` sería un estado sin sentido, pero
la FK compuesta no lo impediría (ver abajo): con `clinicId` a NULL, Postgres no
comprueba nada. Aquí el problema no es de integridad referencial sino de modelo,
y merece su propia revisión en vez de colarlo en una migración de FKs.

## La trampa de las columnas nullable

Importa para cinco de los ocho pares, así que conviene dejarlo escrito.

`BusinessHour.professionalId`, `TimeOff.professionalId`, `User.professionalId`,
`User.clinicId`, `Conversation.patientId` y `Appointment.conversationId` son
**nullable**. Postgres, con el `MATCH SIMPLE` que usa por defecto, **no comprueba
una FK compuesta si cualquiera de sus columnas es NULL**.

Para `BusinessHour` y `TimeOff` eso es justo lo que queremos: `professionalId`
nulo significa "horario de toda la clínica" y debe seguir siendo válido. Pero
implica que **la FK compuesta no da la garantía completa**: protege las filas con
valor y deja pasar las nulas, así que la validación de código no se puede
retirar. Añade una red, no la sustituye.

Conviene no descubrirlo al revisar el PR de la migración, ni —peor— creer que el
problema quedó cerrado.

## Plan sugerido

**Un solo PR**, no cuatro, porque los `@@unique([clinicId, id])` en `Patient`,
`Service` y `Professional` son el grueso del trabajo y sirven para todos los
pares a la vez. Partirlo multiplicaría migraciones sobre las mismas tablas.

1. Correr la query de comprobación **contra producción** y adjuntar el resultado
   al PR. Si sale algo distinto de cero, eso es lo primero a resolver y a mano:
   son datos cruzados entre clínicas.
2. `@@unique([clinicId, id])` en `Patient`, `Service`, `Professional` y
   `Conversation`.
3. FKs compuestas en los cuatro pares de `Appointment` y en
   `Conversation → Patient`.
4. Migración con el mismo guard `RAISE EXCEPTION` del ADR 0022, que para con un
   mensaje útil en vez de con un error genérico de constraint.
5. Dejar `BusinessHour`, `TimeOff` y `User` fuera, con el motivo escrito.

**Lo que NO hay que hacer**: retirar las validaciones de código de
`createAppointment` al añadir las FKs. Por lo de las columnas nullable, y porque
un 400 con un mensaje claro le sirve más a quien llama que un error de constraint
de Postgres.

## Relacionado
[[adr/0022-fk-compuestas-multi-tenant]] · [[adr/0004-pii-y-compliance]] ·
[[notas/2026-09-11-offboarding-clinic-status]]
