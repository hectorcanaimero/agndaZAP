# PRD — Showly (MVP)

**Producto:** Sistema de agendamiento por WhatsApp con recordatorios anti no-show para clínicas y consultorios.
**Autor:** Alejandro (Condor-Martech)
**Fecha:** 8 de agosto de 2026
**Versión:** 0.2 (MVP, ajustado a lo entregado el 2026-09-09)
**Nombre del producto:** Showly (rebrand desde "AgendaZap" — ver [[adr/0013-rename-a-showly]])

---

## 0. Estado (al 2026-09-09)

- **Entregado y desplegado**: bot de WhatsApp con FSM + preclasificador determinista, RAG FAQ,
  recordatorios anti no-show, feedback post-atención, página pública de agendamiento (con link
  desde el bot, [[adr/0018-scheduling-link-wa]]), panel completo de recepción, panel de
  operador SaaS con impersonation auditada, invitaciones por email, leads del landing,
  observabilidad (Pino + Axiom + Sentry) y analytics de producto (Plausible). Deploy en Coolify
  con dominios temporales ([[deploy-coolify]]). Backend: 49 suites / 721 tests.
- **No entregado**: la app Flutter del profesional (`apps/mobile` es un stub). Pasa a Fase 4,
  post-piloto; ver §3 y §9.
- **Auditoría F1**: los P0 y P1 están cerrados (sprints 0-1); la deuda P2 sigue en
  [[auditoria/RESUMEN-finalizacion]].
- **Siguiente**: piloto con 1 clínica real (Fase 5) + build in public.

---

## 1. Problema y objetivo

Las clínicas y consultorios pequeños/medianos en LATAM pierden entre **20% y 30% de sus ingresos** por inasistencias (no-shows) y por gestionar las citas manualmente a través de WhatsApp. La recepcionista responde mensajes, anota en agenda de papel o Excel, y nadie confirma sistemáticamente las citas.

**Objetivo del MVP:** que una clínica pueda ofrecer agendamiento automático por WhatsApp, con confirmaciones y recordatorios que reduzcan las inasistencias, gestionado desde un panel web propio (responsive, también para el profesional; la app móvil nativa queda para la Fase 4).

**Métrica norte (North Star):** reducción del % de no-shows en las clínicas activas. Objetivo interno: bajar no-shows al menos un 30% relativo en los primeros 60 días de uso.

---

## 2. Usuarios

- **Paciente (usuario final):** agenda, reprograma, cancela y confirma su cita por WhatsApp. No instala nada.
- **Recepción / secretaria (usuario admin):** gestiona la agenda, servicios, profesionales y horarios desde el panel web. Ve y responde conversaciones.
- **Profesional / dueño (usuario móvil):** ve su agenda del día y sus citas desde el panel web responsive (`GET /appointments/mine`, feed iCal para su calendario). La app Flutter nativa con push llega en la Fase 4.
- **SUPERADMIN (operador de la plataforma Showly):** rol de operador SaaS con panel propio en `/admin/*`. Puede crear, suspender, reactivar y archivar cuentas de clínica (tenants); ver métricas cross-tenant; acceder al log de auditoría; e impersonar cualquier clínica activa con un JWT temporal de 30 minutos para operar en su contexto. NO opera directamente sobre endpoints de clínica — toda acción transversal pasa por impersonation auditada. Ver [[adr/0014-superadmin-como-operador-saas]].

---

## 3. Alcance del MVP (qué SÍ entra)

### Bot de WhatsApp (vía WAHA)
- Recibe mensajes entrantes y detecta intención con LLM barata (DeepSeek primario, Gemini fallback).
- Flujo de **agendamiento**: elegir servicio → elegir profesional (opcional) → elegir fecha/hora disponible → confirmar → cita creada.
- Flujo de **reprogramación** y **cancelación** por el paciente.
- Responde **preguntas frecuentes** desde una base de conocimiento por clínica (dirección, horarios, precios, formas de pago) vía RAG simple.
- Handoff a humano: si el bot no entiende o el paciente pide "hablar con alguien", marca la conversación para atención humana en el panel.
- Escalado bot → web: cuando el bot no puede cerrar la cita por chat (p. ej. conversación `@lid` sin número), manda un link con token efímero a la página pública que ya trae nombre/teléfono y deja la cita atada a la conversación ([[adr/0018-scheduling-link-wa]]).

### Motor de recordatorios anti no-show (el diferenciador)
- Recordatorio configurable: por defecto 24h antes y 3h antes de la cita.
- Cada recordatorio pide **confirmación** ("Responde SÍ para confirmar, REAGENDAR para cambiar").
- Si el paciente no confirma tras X horas, marca la cita como "en riesgo" y notifica a recepción.
- Al confirmar/cancelar, actualiza el estado de la cita automáticamente.
- Registro de resultados (asistió / no-show / cancelado) para medir la reducción de inasistencias.

### Feedback post-atención
- Cuando una cita pasa a ATENDIDA, el bot pide una calificación 1-5 (y comentario opcional) con un delay configurable por profesional. Resumen y ranking en el panel ([[adr/0012-feedback-post-atencion]]).

### Panel web admin (Next.js — base reutilizada de Blog Condor)
- Auth + multi-tenant (una clínica = un tenant).
- Gestión de: servicios, profesionales, horarios de atención, feriados/bloqueos.
- Agenda visual (día/semana) con estados de cita (pendiente, confirmada, en riesgo, atendida, no-show, cancelada).
- Bandeja de conversaciones de WhatsApp (ver, responder manual, tomar handoff).
- Editor de base de conocimiento (FAQ) por clínica.
- Dashboard: tasa de no-show, citas por estado, confirmaciones, tendencia.
- Pacientes con historial, feedback post-atención, conexión del WhatsApp por QR desde el panel, ajustes de la clínica (TZ, recordatorios, auto-confirmación).
- El panel es responsive y es la herramienta del profesional mientras no exista la app nativa.

### Página pública de agendamiento
- `/agendar/[clinicSlug]`: catálogo, slots disponibles, alta de cita con consentimiento explícito, rate-limit y anti-spam. Sirve para links compartidos, QR, redes y como destino del escalado desde el bot.

### Panel de operador SaaS (SUPERADMIN)
- Alta de clínicas con invitación por email al admin, suspensión/reactivación, impersonation auditada, métricas cross-tenant, leads del landing ([[adr/0014-superadmin-como-operador-saas]], [[adr/0016-admin-audit-impersonation-trail]]).

### Landing, leads y analytics
- Landing en es/pt con formulario de leads y página de seguridad. Analytics con Plausible (sin cookies ni PII) para medir el embudo landing → formulario → cita ([[notas/2026-09-09-analytics-plausible]]).

### App Flutter (profesional/dueño) — movida a Fase 4 (post-piloto)
> **ESTADO (2026-09-09): NO implementada y fuera del alcance del MVP.** `apps/mobile` es un
> stub (sólo `README.md`, auditoría F1.6.T1). Mitigación aceptada para el piloto: el panel web
> es responsive y ya cubre al profesional (agenda propia vía `GET /appointments/mine`, detalle
> de cita con contacto, feed iCal para su calendario del teléfono). Lo que sigue faltando es
> push nativo y un endpoint de confirmar/bloquear con rol PROFESSIONAL; ambos se diseñan en la
> Fase 4 (ver `apps/mobile/README.md`).
- Login.
- Agenda del día/semana (solo lectura + confirmar/bloquear).
- Notificación push cuando hay cita nueva o cancelación.
- Ver datos de contacto del paciente.

---

## 4. Fuera de alcance (qué NO entra en el MVP)

- Pagos / cobro de señas online (fase 2 — importante para anti no-show, pero se pospone).
- Multi-idioma más allá de es/pt (la base ya lo soporta; se activa después).
- Integración con sistemas de historia clínica / EMR.
- API oficial de WhatsApp (se usa WAHA; migración oficial es fase posterior).
- Campañas de marketing / reactivación de pacientes inactivos (fase 2).
- Multi-sede compleja por clínica (MVP: una agenda por clínica, con múltiples profesionales).

---

## 5. Flujos principales

### 5.1 Paciente agenda (happy path)
1. Paciente escribe al WhatsApp de la clínica: "Quiero una cita".
2. Bot detecta intención = agendar. Pregunta servicio.
3. Paciente elige servicio (lista o texto libre interpretado por LLM).
4. Bot ofrece próximos horarios disponibles (según agenda, servicio y profesional).
5. Paciente elige. Bot confirma datos y crea la cita (estado: CONFIRMADA o PENDIENTE según config).
6. Bot envía confirmación con fecha, hora, dirección y botón de cancelar/reagendar.

### 5.2 Recordatorio anti no-show
1. Job programado dispara el recordatorio (24h y 3h antes).
2. Bot envía mensaje pidiendo confirmación.
3. Paciente responde SÍ → cita CONFIRMADA. Responde REAGENDAR → entra al flujo de reprogramación. Responde CANCELAR → cita CANCELADA + libera el horario.
4. Si no responde antes del umbral → cita marcada EN_RIESGO + alerta a recepción en el panel.

### 5.3 Handoff a humano
1. Bot no entiende o paciente pide humano.
2. Conversación marcada NEEDS_HUMAN.
3. Aparece resaltada en la bandeja del panel; recepción responde manual; el bot se silencia en esa conversación hasta que se reactive.

---

## 6. Requisitos no funcionales

- **Costo por conversación:** fracciones de centavo (LLM barata + cache). Objetivo < $0.01/conversación.
- **Multi-tenant:** aislar datos por clínica desde el día uno (tenantId en todo).
- **Resiliencia WhatsApp:** WAHA puede desconectarse o el número puede ser baneado. El sistema debe detectar desconexión y alertar; reintentos con backoff en el envío.
- **Privacidad (salud):** datos de pacientes tratados con cuidado; cifrado en tránsito; no exponer datos entre tenants. Consentimiento básico registrado.
- **Zona horaria:** por clínica (America/Caracas, America/Sao_Paulo, etc.). Toda la lógica de agenda y recordatorios respeta el TZ del tenant.
- **Idempotencia:** creación de citas y envío de recordatorios idempotentes (evitar dobles).

---

## 7. Riesgos y supuestos

- **Supuesto (no validado):** clínicas pagarán ~$15-30/mes por esto. Pendiente de confirmar con clientes reales.
- **Decisión de producto pendiente de confirmar (precio):** el FAQ nuevo del landing quiere prometer que "cuando salgamos del piloto, el plan base va a costar menos que un no-show a la semana". Es una promesa pública de posicionamiento de precio, no un precio cerrado; hoy el landing en `main` sólo dice "cuando salgamos del piloto te avisamos 30 días antes". Antes de publicarla hay que fijar el plan base y validar el valor promedio de un no-show con la clínica piloto. No darla por cerrada.
- **Riesgo alto:** baneo de números por WAHA (no oficial). Mitigación: números dedicados, volumen moderado, plan de migración a API oficial si un cliente escala.
- **Riesgo:** sensibilidad de datos de salud. Mitigación: minimizar datos almacenados, cifrado, y términos claros.
- **Riesgo:** el LLM malinterpreta y agenda mal. Mitigación: confirmación explícita antes de crear la cita + handoff fácil.

---

## 8. Criterios de éxito del MVP

- Una clínica real puede operar su agenda end-to-end por WhatsApp durante 2 semanas sin intervención manual crítica.
- El sistema envía recordatorios y registra confirmaciones/no-shows correctamente.
- Se puede mostrar en el dashboard la tasa de no-show antes/después.
- Tiempo de alta de una nueva clínica (onboarding): < 1 hora.

---

## 9. Roadmap por fases

- **Fase 0 (infra + esqueleto):** monorepo, docker-compose, schema, auth multi-tenant, conexión WAHA. **Hecha.**
- **Fase 1 (core agendamiento):** servicios/profesionales/horarios, motor de disponibilidad, flujo de agendar por WhatsApp. **Hecha.**
- **Fase 2 (anti no-show):** motor de recordatorios + confirmaciones + estados + alertas. **Hecha** (+ feedback post-atención).
- **Fase 3 (panel):** agenda visual, bandeja de conversaciones, dashboard, FAQ, página pública, panel SaaS, observabilidad, deploy. **Hecha.**
- **Fase 5 (piloto):** onboarding de 1 clínica real + build in public. **Siguiente.** Sprints 0-1 (CI, deploy Coolify, P1 de seguridad) cerrados; sprint 2 en PRs; sprint 3 (docs y deuda) en curso — ver [[bitacora]].
- **Fase 4 (app Flutter, post-piloto):** agenda del profesional + push. Se ejecuta después del piloto, con lo aprendido; `apps/mobile` es un stub (auditoría F1.6.T1 en `apps/mobile/README.md`).

---

## 10. Cambios

- **2026-09-09 (v0.2)** — Sección "Estado" nueva; la app Flutter pasa de "alcance del MVP" a
  "Fase 4 (post-piloto)" con la mitigación del panel responsive; el alcance del MVP refleja lo
  entregado (link bot → web, feedback post-atención, página pública, panel SaaS, landing +
  leads + analytics); la promesa de precio del FAQ ("menos que un no-show a la semana") queda
  registrada como decisión pendiente en §7; roadmap §9 con estado por fase. El producto no cambia.
- **2026-08-22 (v0.1, auditoría F1)** — Nota de estado de la app Flutter (F1.6.T1) y rol SUPERADMIN (ADR 0014).
- **2026-08-08 (v0.1)** — Versión inicial.
