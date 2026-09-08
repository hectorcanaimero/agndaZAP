# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Este workspace (`apps/web`) sirve a tres audiencias distintas — cada superficie del monorepo tiene su público:

- **Recepción / secretaria de clínica (CLINIC_ADMIN)** — usuario diario del panel `/panel/*`. Opera desde escritorio en la clínica (a veces tablet). Gestiona agenda visual, bandeja de conversaciones WhatsApp, servicios, profesionales, horarios, bloqueos, feriados, FAQ, y dashboard de no-show. Necesita velocidad, densidad de información, y cero fricción para tareas que hace decenas de veces al día.
- **SUPERADMIN de Showly (operador SaaS)** — panel `/admin/*`. Crea, suspende, reactiva y archiva tenants (clínicas). Ve métricas cross-tenant, log de auditoría, e impersona una clínica con JWT temporal de 30 min. NO opera endpoints de clínica directo — toda acción transversal pasa por impersonation auditada. Ver [[docs/adr/0014-superadmin-como-operador-saas]].
- **Visitante de landing / lead / paciente de una clínica activa** — dos superficies públicas: (1) `/` landing pública en showly.us, dirigida a dueños/administradores de clínicas LATAM que buscan reducir no-shows, con formulario de captura de leads; (2) `/agendar/[clinicSlug]` página pública SSR donde el paciente final agenda sin instalar nada (form paciente + selección de slot + crear cita, con rate-limit anti-spam).

El **paciente por WhatsApp** y el **profesional en app móvil (Flutter)** son usuarios del sistema Showly pero NO consumen `apps/web` — viven en `apps/backend` (WAHA bot) y `apps/mobile` (aún stub) respectivamente.

## Product Purpose

Showly es un sistema de agendamiento por WhatsApp con recordatorios anti no-show para clínicas y consultorios pequeños/medianos en LATAM. La aplicación web `apps/web` sirve tres propósitos:

1. **Vender el producto** (landing en `/`) — captar leads de dueños/administradores de clínicas.
2. **Operar la clínica** (panel `/panel/*`) — que recepción gestione la agenda, conversaciones y configuración de la clínica sin fricción.
3. **Operar el SaaS** (panel `/admin/*`) — que el operador Showly administre tenants con impersonation auditada.
4. **Facilitar el agendamiento sin WhatsApp** (página pública `/agendar/[clinicSlug]`) — canal alternativo al bot para pacientes que llegan por web o link directo.

**Éxito para la clínica:** reducción del 30% relativo en no-shows dentro de los primeros 60 días (North Star). **Éxito para el operador SaaS:** onboarding de una clínica nueva en menos de 1 hora, cero fugas de datos entre tenants, cero pérdida de auditoría en acciones cross-tenant.

## Positioning

Tres claims que un competidor cercano NO puede copiar sin cambiar su arquitectura:

- **Anti no-show como núcleo, no como feature:** los recordatorios con confirmación automática y el estado `EN_RIESGO` en la agenda son el diferenciador. Cada cita tiene un ciclo de vida (pendiente → confirmada → en riesgo → atendida / no-show / cancelada) que se registra para medir la reducción real.
- **Costo por conversación en fracciones de centavo (<$0.01):** stack de LLM barata (DeepSeek primario, Gemini fallback) + WAHA (WhatsApp no oficial) + cache. Permite precio mensual bajo (~$15–30/mes hipotéticos, [inferido — supuesto no validado según PRD §7]) accesible a clínicas pequeñas que no pagarían la API oficial de WhatsApp.
- **Multi-tenant aislado desde el día uno:** `clinicId` en toda entidad + validado en JWT + guards en cada query. Página pública con `clinicSlug` en URL. Impersonation SUPERADMIN via JWT temporal auditada, nunca acceso directo cross-tenant.

## Operating Context

**Panel (`/panel/*`)** — Recepción abre el panel al empezar el turno y lo mantiene abierto todo el día. Consulta agenda del día (vista día/semana), atiende la bandeja de conversaciones cuando el bot escala con `NEEDS_HUMAN`, y toca configuración esporádicamente (servicios, horarios, FAQ). Uso primario en escritorio (>=1280px); tablet como secundario; mobile responsive [inferido — presente en el código con `MobileDrawer.tsx` pero no es el escenario dominante].

**Admin SaaS (`/admin/*`)** — SUPERADMIN Showly. Uso esporádico y de alto impacto: alta/suspensión de clínicas, auditoría, impersonation cuando hay soporte. Escritorio siempre.

**Landing (`/`)** — Visitante llega desde marketing, contenido, o boca a boca. Debe decidir en <60s si vale la pena dejar un lead. Escritorio y mobile por igual.

**Página pública (`/agendar/[clinicSlug]`)** — Paciente llega desde un link (WhatsApp, sitio de la clínica, QR en recepción). Mobile es el escenario dominante. Debe agendar en <3 pantallas sin registrarse.

**i18n:** es + pt (LATAM + Brasil). El copy de marketing y superficies públicas usa **ES latinoamericano neutro (tú)**, no Rioplatense — ver memoria feedback_copy_latam_spanish.

**Deploy:** producción en showly.us (Coolify + Contabo desde 2026-08-18). Sentry activo tanto client como server. Health check en `/api/health`.

## Capabilities and Constraints

**Capabilities disponibles en el workspace:**
- Auth con JWT (backend NestJS), middleware Next para route protection.
- Multi-tenant vía `clinicId` en JWT + guards en cada query del backend.
- i18n con next-intl (es/pt), rutas `/[locale]/...`.
- SSR para landing y página pública `/agendar/[clinicSlug]`; CSR con TanStack Query para el panel.
- shadcn/ui + Radix como sistema base de componentes; Tailwind v3 como capa de estilo; framer-motion para animación; next-themes para dark mode [inferido — presente en deps, verificar si está expuesto al usuario].
- Recharts para dashboard.
- Sonner para toasts; react-hook-form + zod para formularios; @uiw/react-md-editor para editor de FAQ.
- Impersonation SUPERADMIN → CLINIC_ADMIN con banner visible y expiración a 30 min (`ImpersonationBanner.tsx`).
- Captura de leads (POST /public/leads con rate-limit + honeypot) — reemplazó el mailto: del FinalCta.

**Constraints duras:**
- **Fechas y horas: SIEMPRE Luxon con la TZ de la clínica.** Nunca `Date` naive. Aplica a agenda, recordatorios, disponibilidad, display de citas.
- **Multi-tenant estricto:** cada query, cada endpoint, cada componente que muestre datos debe validar tenant. Cero fugas.
- **PII de salud:** datos de pacientes son sensibles. Cifrado en tránsito. No exponer entre tenants. Consentimiento básico registrado.
- **Idempotencia:** creación de citas y envío de recordatorios idempotentes.
- **TypeScript strict.**
- **App móvil (Flutter, `apps/mobile`) NO existe aún** — es un stub. Cualquier flujo que dependa de "el profesional tiene app" debe tener mitigación web (panel responsive) [documentado en PRD §3 y auditoría F1.6.T1].

**Terminología clave:**
- **Tenant = Clínica.** Un tenant = un `clinicId` = una sesión WAHA.
- **Estados de cita:** PENDIENTE, CONFIRMADA, EN_RIESGO, ATENDIDA, NO_SHOW, CANCELADA.
- **Estados de conversación WhatsApp:** BOT_ACTIVO, NEEDS_HUMAN.
- **Roles:** SUPERADMIN, CLINIC_ADMIN, PROFESIONAL [presente en código; verificar completitud].

**Explícitamente indefinido a nivel producto:**
- Precio real y pricing tiers (el `$15–30/mes` del PRD es hipótesis no validada).
- Onboarding wizard para CLINIC_ADMIN — plan aprobado 2026-08-11 pero NO implementado (ver memoria project_onboarding_wizard_plan).
- Pagos / cobro de señas online (fuera de MVP, fase 2).

## Brand Commitments

- **Nombre:** Showly (rebrand desde AgendaZap/gochat, 2026-08-11, PR #18, ver [[docs/adr/0013-rename-a-showly]]).
- **Wordmark:** wordmark navy con mark teal companion (elegido 2026-08-11). Assets en `apps/web/assets/generated/`. Componente `<Logo>` en `src/components/landing/Logo.tsx`; los shells `PanelShell` y `AdminShell` lo consumen — no usar cuadraditos de color con íconos Sparkles/ShieldCheck (ver memoria project_shells_use_real_wordmark).
- **Paleta:**
  - Primary navy: `#0F2A4A`
  - Accent teal: `#28D9B9`
  - (Confirmar tokens completos en `tailwind.config.ts` durante `/impeccable document` posterior.)
- **Voz y copy:**
  - Superficies públicas (landing, marketing, página pública `/agendar/[clinicSlug]`, footer, meta tags, emails): **ES-LATAM neutro (tú)**, cálido y directo. NO Rioplatense.
  - Superficies internas (panel, admin): mismo registro que ES-LATAM neutro; sin jerga técnica innecesaria hacia recepción.
  - pt-BR sigue el mismo tono neutro y cercano (informal "você") [inferido — validar con revisión de `messages/pt.json` en `/impeccable document`].

## Evidence on Hand

**Documentación de producto (vault Obsidian en `docs/`):**
- `docs/PRD.md` — MVP definido, 4 personas, alcance/no-alcance, flujos, riesgos, roadmap. Actualizado 2026-08-22.
- `docs/SPEC.md` — contratos + escenarios.
- `docs/ARCHITECTURE.md` — decisiones técnicas.
- `docs/adr/` — ADRs numeradas; críticas para este workspace: 0013 (rebrand), 0014 (SUPERADMIN operador SaaS).
- `docs/deploy.md`, `docs/runbook-panel.md`, `docs/runbook-lanzamiento.md`, `docs/onboarding-clinica.md`.
- `docs/bitacora.md` — historial de decisiones.

**Producción viva:**
- https://showly.us — LIVE desde 2026-08-18 (Coolify + Contabo, LE cert válido, running:healthy).

**Assets:**
- Logo wordmark + mark teal en `apps/web/assets/generated/`.
- Favicon companion.
- Ver memoria `project_brand_kit_showly` para paths y versiones.

**Ausencias que ningún trabajo futuro debe fabricar:**
- **Testimonios reales de clientes:** el componente `Testimonial.tsx` existe pero NO hay clínica en producción validada con caso de éxito publicable. No inventar nombres, quotes ni logos.
- **Métricas de reducción de no-show reales:** el objetivo del 30% en 60 días es la hipótesis del PRD, no un resultado medido. No mostrar como dato histórico.
- **Pricing público final:** el PricingSection existe pero el precio real no está validado con mercado. Cualquier número mostrado es hipótesis, no promesa contractual.
- **Piloto operativo con 40 clínicas:** los commits mencionan "40 clínicas" en contexto de reconciliación pre-lanzamiento, pero NO existe evidencia de que 40 clínicas estén operando hoy. No usar ese número como social proof.

## Product Principles

1. **WhatsApp-first pero no WhatsApp-only.** El bot es el canal primario del paciente, pero `/agendar/[clinicSlug]` y el panel de recepción deben ser igual de sólidos — cada canal es un ciudadano de primera clase, no un fallback.
2. **Anti no-show es medible o no existe.** Cada estado de cita se registra. Cada recordatorio deja rastro. El dashboard debe poder mostrar "antes de Showly / después de Showly" de forma honesta.
3. **Aislamiento multi-tenant es no negociable.** Ningún componente, query, cache, ni URL puede exponer datos de otra clínica. Cuando en duda, romper el flujo antes que arriesgar una fuga.
4. **TZ de la clínica es la única verdad temporal.** Toda fecha visible o comparable pasa por Luxon + TZ del tenant. Un bug de TZ en agenda es un bug crítico.
5. **Bajo costo operativo es una promesa al cliente.** Cualquier feature que empuje el costo por conversación por encima de $0.01 requiere justificación explícita y validación con el negocio antes de mergear.

## Accessibility & Inclusion

Sin estándar formal establecido a nivel producto. Baseline razonable [inferido] para las superficies públicas (landing + `/agendar/[clinicSlug]`): WCAG 2.1 AA en contraste, foco visible, navegación por teclado, targets táctiles ≥44px en mobile, labels asociados a inputs. Necesidades específicas de accesibilidad para el sector clínico LATAM (pacientes mayores usando WhatsApp, recepcionistas con manos ocupadas, etc.) NO han sido investigadas. Registrar como decisión abierta antes de auditar formalmente.
