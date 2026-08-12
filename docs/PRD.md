# PRD — Showly (MVP)

**Producto:** Sistema de agendamiento por WhatsApp con recordatorios anti no-show para clínicas y consultorios.
**Autor:** Alejandro (Condor-Martech)
**Fecha:** 8 de agosto de 2026
**Versión:** 0.1 (MVP)
**Nombre del producto:** Showly (rebrand desde "AgendaZap" — ver [[adr/0013-rename-a-showly]])

---

## 1. Problema y objetivo

Las clínicas y consultorios pequeños/medianos en LATAM pierden entre **20% y 30% de sus ingresos** por inasistencias (no-shows) y por gestionar las citas manualmente a través de WhatsApp. La recepcionista responde mensajes, anota en agenda de papel o Excel, y nadie confirma sistemáticamente las citas.

**Objetivo del MVP:** que una clínica pueda ofrecer agendamiento automático por WhatsApp, con confirmaciones y recordatorios que reduzcan las inasistencias, gestionado desde un panel web propio y una app móvil para el profesional.

**Métrica norte (North Star):** reducción del % de no-shows en las clínicas activas. Objetivo interno: bajar no-shows al menos un 30% relativo en los primeros 60 días de uso.

---

## 2. Usuarios

- **Paciente (usuario final):** agenda, reprograma, cancela y confirma su cita por WhatsApp. No instala nada.
- **Recepción / secretaria (usuario admin):** gestiona la agenda, servicios, profesionales y horarios desde el panel web. Ve y responde conversaciones.
- **Profesional / dueño (usuario móvil):** ve su agenda del día, confirma o bloquea horarios desde la app Flutter.
- **Super-admin (tú/Condor-Martech):** gestiona clínicas (tenants), instancias de WhatsApp, y monitorea el sistema.

---

## 3. Alcance del MVP (qué SÍ entra)

### Bot de WhatsApp (vía WAHA)
- Recibe mensajes entrantes y detecta intención con LLM barata (DeepSeek primario, Gemini fallback).
- Flujo de **agendamiento**: elegir servicio → elegir profesional (opcional) → elegir fecha/hora disponible → confirmar → cita creada.
- Flujo de **reprogramación** y **cancelación** por el paciente.
- Responde **preguntas frecuentes** desde una base de conocimiento por clínica (dirección, horarios, precios, formas de pago) vía RAG simple.
- Handoff a humano: si el bot no entiende o el paciente pide "hablar con alguien", marca la conversación para atención humana en el panel.

### Motor de recordatorios anti no-show (el diferenciador)
- Recordatorio configurable: por defecto 24h antes y 3h antes de la cita.
- Cada recordatorio pide **confirmación** ("Responde SÍ para confirmar, REAGENDAR para cambiar").
- Si el paciente no confirma tras X horas, marca la cita como "en riesgo" y notifica a recepción.
- Al confirmar/cancelar, actualiza el estado de la cita automáticamente.
- Registro de resultados (asistió / no-show / cancelado) para medir la reducción de inasistencias.

### Panel web admin (Next.js — base reutilizada de Blog Condor)
- Auth + multi-tenant (una clínica = un tenant).
- Gestión de: servicios, profesionales, horarios de atención, feriados/bloqueos.
- Agenda visual (día/semana) con estados de cita (pendiente, confirmada, en riesgo, atendida, no-show, cancelada).
- Bandeja de conversaciones de WhatsApp (ver, responder manual, tomar handoff).
- Editor de base de conocimiento (FAQ) por clínica.
- Dashboard: tasa de no-show, citas por estado, confirmaciones, tendencia.

### App Flutter (profesional/dueño)
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

- **Fase 0 (infra + esqueleto):** monorepo, docker-compose, schema, auth multi-tenant, conexión WAHA. 
- **Fase 1 (core agendamiento):** servicios/profesionales/horarios, motor de disponibilidad, flujo de agendar por WhatsApp.
- **Fase 2 (anti no-show):** motor de recordatorios + confirmaciones + estados + alertas.
- **Fase 3 (panel):** agenda visual, bandeja de conversaciones, dashboard, FAQ.
- **Fase 4 (app Flutter):** agenda del profesional + push.
- **Fase 5 (piloto):** onboarding de 1 clínica real + build in public.
