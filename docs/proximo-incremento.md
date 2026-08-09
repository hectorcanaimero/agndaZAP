# Próximo incremento — Plan de trabajo

> Retomar aquí en Claude Code. Seguir el flujo `/spec` (ya hecho) → `/plan` → `/build` → `/test` → `/review`.
> Al cerrar cada bloque: marcar el checkbox, anotar en [[bitacora]] y crear ADR/nota si hubo decisión o gotcha.

## Bloque 1 — Wiring NestJS ejecutable (desbloquea todo)
- [ ] `apps/backend/src/main.ts` — bootstrap + ValidationPipe global + puerto 4000.
- [ ] `apps/backend/src/app.module.ts` — importa todos los módulos.
- [ ] `apps/backend/src/prisma/prisma.service.ts` — `PrismaClient` + `onModuleInit`/`enableShutdownHooks`.
- [ ] Provider de la cola BullMQ (`REMINDERS_QUEUE`) inyectable (patrón Symbol DI de Blog Condor).
- [ ] Arranque del worker `createRemindersWorker` en el bootstrap (o proceso worker aparte).
- [ ] `tsconfig.json` strict + `nest-cli.json`.
- [ ] Smoke: `pnpm dev:backend` levanta sin errores; `POST /webhooks/waha` responde 200.
- **DoD:** compila strict, arranca, webhook responde.

## Bloque 2 — FSM de agendamiento en el bot
- [ ] `bot.service.ts`: implementar los pasos `ASK_SERVICE → ASK_PROFESSIONAL → ASK_SLOT → CONFIRM`.
- [ ] Usar `AvailabilityService.getSlots` para ofrecer horarios reales.
- [ ] Al confirmar: crear `Appointment` (validando slot libre) y llamar `RemindersService.scheduleForAppointment`.
- [ ] Guardar el paso en `Conversation.flowStep` + `flowData` (retomable).
- [ ] Confirmación explícita antes de crear (regla de SPEC).
- **DoD:** tests de los escenarios Gherkin "agenda en horario disponible" y "no doble reserva".

## Bloque 3 — Página pública `/agendar/[clinicSlug]` (apps/web)
- [ ] Ruta SSR Next.js que carga clínica por slug + servicios/profesionales.
- [ ] Formulario: datos del paciente (nombre, teléfono, motivo) + consentimiento.
- [ ] Selección de servicio/profesional/slot (consume `GET /api/availability`).
- [ ] `POST /api/public/appointments` (sin auth) con **rate-limit + validación anti-spam** (Redis).
- [ ] Al crear: misma lógica que el bot (cita + recordatorios). Confirmación por WhatsApp.
- **DoD:** un paciente puede agendar end-to-end desde el navegador; rate-limit probado.

## Dependencias / notas
- Bloque 2 y 3 comparten el `SchedulingService` — extraer la creación de cita a un service reutilizable
  (no duplicar entre bot y endpoint público).
- Auth + guards multi-tenant (RBAC) puede ir en paralelo; la página pública NO usa auth pero SÍ valida el slug.
- Recordar: toda fecha con Luxon + TZ de la clínica. Invocar `security-auditor` antes de mergear el endpoint público.
