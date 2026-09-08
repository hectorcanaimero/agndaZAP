# apps/mobile — App Flutter del profesional (NO implementada — gap P0 vs PRD)

**Audit F1.6.T1** (2026-08-22) — ver `docs/specs/f1-auditoria-finalizacion.md` §F1.6.T1.

## Veredicto

`apps/mobile` es un **stub**: solo existe este README, sin `pubspec.yaml`, sin
toolchain Dart/Flutter inicializado, sin CI, sin código. La **Fase 4** del
`docs/PRD.md` (app Flutter del profesional) está **0% implementada**.

Clasificación: **P0 frente a PRD §3** (es una de las cuatro superficies
prometidas en el alcance del MVP y una de las cuatro personas de usuario tiene
cero entregable). Mitigación para el piloto: el panel web es responsive y cubre
la agenda + confirmar/bloquear desde el móvil, por lo que la persona "profesional"
no queda sin herramienta en el piloto de la Fase 5. Con esa mitigación el impacto
de lanzamiento baja a **P1**.

## Alcance que falta (Fase 4 PRD)

| Feature PRD §3/Fase 4 | Estado | Alcance pendiente para la futura fase |
|---|---|---|
| Login del profesional | Backend listo, app faltante | App Flutter consumiendo `POST /auth/login` + `GET /auth/me` (JWT). Falta app + token storage seguro + refresh. |
| Agenda del día/semana (solo lectura) | Backend listo, app faltante | `GET /appointments/mine` (rol PROFESSIONAL) ya existe. Falta UI Flutter (día/semana), estado offline. |
| Ver datos de contacto del paciente | Backend listo, app faltante | `GET /appointments/:id` (PROFESSIONAL) ya existe. Falta pantalla de detalle con contacto. |
| Confirmar / bloquear desde la app | Backend PARCIAL | No hay endpoint de confirmar/bloquear scoped a PROFESSIONAL: `PATCH /appointments/:id/status` y `PATCH /appointments/:id/reschedule` son solo CLINIC_ADMIN/SUPERADMIN. Falta endpoint PROFESSIONAL-scoped + UI. |
| Notificación push (cita nueva / cancelación) | Backend FALTANTE | No existe infra de push en el backend (ni FCM/APNs/Expo/OneSignal). Falta: registro de device token, disparo de push en eventos de cita (creación/cancelación), y lado Flutter. |

## Impacto en el piloto

- El MVP queda sin entregable móvil para el "Profesional / dueño (usuario móvil)"
  de `docs/PRD.md` §2. La Fase 5 (piloto) puede arrancar igual porque el panel
  web responsive cubre la operación diaria; la app Flutter se posterga a una
  fase posterior.
- La infra de push es el único bloqueo de arquitectura transversal: hay que
  decidir proveedor (FCM + Expo/OneSignal) y diseño de eventos antes de codear.
  Ver `docs/adr/0011-perfil-profesional-e-ical-feed.md` (ya deja la base de
  contrato para el consumidor móvil).

## Referencias

- `docs/PRD.md` §3 "App Flutter" y §9 Fase 4.
- `docs/adr/0001-monorepo.md` (Flutter fuera del workspace pnpm).
- Backend ya disponible: `apps/backend/src/auth/auth.controller.ts`, `apps/backend/src/appointments/appointments.controller.ts`.
