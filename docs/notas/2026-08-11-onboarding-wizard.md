# 2026-08-11 — Plan del wizard de onboarding first-time para CLINIC_ADMIN

Diseño técnico + UX de un wizard guiado para que un `CLINIC_ADMIN` configure su clínica en
~5 minutos self-service. Reemplaza el playbook manual actual documentado en
[[../onboarding-clinica|onboarding-clinica]] (45 min con acompañamiento del equipo Showly).

Frameworks aplicados: `ui-ux-pro-max` (accesibilidad, mobile-first, animation ≤300ms, form UX) y
`marketing-psychology` (goal-gradient, IKEA effect, endowment, Zeigarnik, default effect,
peak-end rule, paradox of choice, reciprocity, loss aversion).

Este es un **plan aprobado, no implementado todavía**. Al arrancar la implementación, seguir
el roadmap de la sección "Roadmap de implementación" y crear un ADR nuevo si aparecen
decisiones no obvias durante el build.

## Contexto

Hoy Showly tiene el panel completo (Servicios, Profesionales, Horarios, FAQ, WhatsApp,
Ajustes) pero **no tiene onboarding guiado**. Cuando un `CLINIC_ADMIN` entra por primera vez
al panel, ve un dashboard vacío y tiene que descubrir por sí mismo qué configurar y en qué
orden. Además, hoy la creación de clínica/usuario es manual via SQL/Prisma Studio (deuda
documentada en [[../adr/0005-auth-mvp-y-deuda|ADR 0005]]).

Este wizard:

- **Reduce time-to-activation** de ~45 min (con acompañamiento) a **~5 min self-service**.
- **Aumenta completion rate** aplicando marketing psychology (ver frameworks arriba).
- **No requiere endpoint nuevo de creación de clínica** en el MVP: la clínica sigue siendo
  creada por SUPERADMIN via SQL/seed en fase gratis. En v2 (self-service) se extiende el
  mismo shell con un step 0 opcional de "crear clínica".
- **Peak experience en WhatsApp conectado**: confetti + copy "¡Tu bot está en línea!"
  (esto ancla la memoria de valor — peak-end rule).
- **End state memorable**: link público para compartir + widget de próximos pasos en dashboard.

## Alcance del MVP

**Sí incluye:**

- Ruta nueva `/[locale]/onboarding/[step]` (5 pasos) fuera del layout de panel.
- 5 componentes de step + `<Stepper>` + `<ProgressBar>` + `<OnboardingShell>` + `OnboardingContext`.
- Templates de servicios por tipo de clínica, presets de horarios, FAQ templates.
- Estado WhatsApp con polling reutilizando el hook del panel actual
  ([[2026-08-09-bloque-waha-panel-conexion|bloque WAHA panel]]).
- Migration Prisma: `Clinic.onboardingCompletedAt` + `Clinic.onboardingProgress` + backfill.
- Endpoint `PATCH /clinics/me/onboarding` + extender `GET /auth/me`.
- Widget Zeigarnik en `panel/dashboard` para admins que abandonen mid-wizard.
- i18n `onboarding.*` en `es.json` + `pt.json` (español latam neutral con **tú**, no vos).

**NO incluye (v2 / fuera de scope):**

- Endpoint `POST /clinics` (creación self-service de clínica).
- Admin UI para editar templates de servicios/FAQ.
- Onboarding para role `PROFESSIONAL` (nunca ven el wizard, van directo al panel).
- Analytics/PostHog integration (solo dejamos hooks de logging con `event=onboarding.*`).

## Decisiones tomadas (aprobadas)

| Decisión                     | Elegido                                                   | Impacto                                                              |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| Quién completa el onboarding | `CLINIC_ADMIN`, clínica ya creada por SUPERADMIN          | No creamos `POST /clinics` en MVP; arquitectura queda lista para v2  |
| FAQ en el wizard             | Card opcional en Bienvenida + widget en dashboard         | Cero fricción; se crean silenciosamente si el user acepta            |
| Gating del panel             | Redirect suave con "Guardar y salir" + Zeigarnik pull     | Balance UX vs activación; middleware redirige pero no bloquea        |

## Arquitectura Next.js

### Rutas nuevas

```
apps/web/src/app/[locale]/onboarding/
├── layout.tsx                  Layout minimal (logo + progress + "Guardar y salir"). SSR: chequea sesión + redirect si ya completó.
├── page.tsx                    Redirige al step actual según onboardingProgress.currentStep
├── [step]/page.tsx             Server component que despacha al StepComponent según [step] (1-5)
├── OnboardingShell.tsx         Client: layout con Stepper, ProgressBar, "Guardar y salir"
├── OnboardingContext.tsx       Client provider: estado global + PATCH debounceado (500ms)
├── steps/
│   ├── StepWelcome.tsx         Step 1: tipo de clínica + checkbox FAQs pre-cargadas
│   ├── StepService.tsx         Step 2: primer servicio con chips de sugerencias
│   ├── StepProfessional.tsx    Step 3: primer profesional (pre-fill con me.name)
│   ├── StepHours.tsx           Step 4: 3 presets de horarios + custom
│   ├── StepWhatsapp.tsx        Step 5: QR + polling + 6 estados visuales
│   └── StepCelebration.tsx     Post-WORKING: confetti + link público a compartir
└── templates/
    ├── serviceTemplates.ts     5 servicios × 5 tipos de clínica
    ├── hourPresets.ts          3 presets (L-V 9-18, L-S 9-18, turno partido)
    └── faqTemplates.ts         8 FAQs pre-armadas por tipo
```

### Middleware existente + extensión

`apps/web/src/middleware.ts` ya tiene `PANEL_REGEX`. Agregamos:

- Cookie hint `showly_onboarding=pending|done` seteada por el login handler al recibir el
  response de `/auth/login` (extender el endpoint para incluir `onboardingCompletedAt`).
- Regla nueva: si `PANEL_REGEX.test(pathname)` y cookie `showly_onboarding === 'pending'` y
  role no es `PROFESSIONAL` → redirect a `/[locale]/onboarding/1`.
- Regla inversa: si el user entra a `/onboarding` con cookie `done` y sin `?rerun=1` →
  redirect a `/panel/dashboard`.

**Rationale**: el middleware **no valida**, solo hace UX routing. El backend siempre re-valida
en cada endpoint. La cookie se re-escribe en el server layout de panel (patch chico en
`panel/layout.tsx`).

## Secuencia de 5 steps

| # | Step                       | Obligatorio | Skippable                    | Principio psicológico                                        |
| - | -------------------------- | ----------- | ---------------------------- | ------------------------------------------------------------ |
| 1 | Bienvenida + tipo clínica  | Sí (1 click)| No                           | Warmup, reciprocity (habilita templates)                     |
| 2 | Primer servicio            | Sí          | No                           | Foot-in-the-door (1 campo), IKEA effect                      |
| 3 | Primer profesional         | Sí          | No                           | Default effect (checkbox pre-marcada al servicio del step 2) |
| 4 | Horarios                   | Sí (preset default) | No                   | Paradox of choice (3 presets max), activation energy baja    |
| 5 | WhatsApp                   | Recomendado | Sí con fricción explícita    | Peak-end rule: confetti al conectar                          |

**Por qué WhatsApp al final (y no primero):**

- Requiere el celular físico → contexto distinto. Si es step 1 y no lo tenés a mano, abandonás.
- Con Servicio + Profesional + Horarios ya creados, cuando conecta WhatsApp el bot
  **funciona de verdad** → feedback loop instantáneo.
- El "clic" del `WORKING` es celebración natural: peak-end anclado al último momento memorable.

**Por qué FAQ no es step:** requiere pensar respuestas → alta activation energy → drop-off. El
bot funciona sin FAQs (cae a fallback + intent — ver [[2026-08-09-rag-faq|bloque RAG FAQ]]).
Se ofrece como checkbox opcional en step 1 ("¿Quieres que carguemos 5 preguntas típicas por
ti?" — pre-marcado, default effect + reciprocity).

## UX por step

Copy en **español latam neutral con "tú"** (no "vos"). Portugués BR paralelo.

### Step 1 — Bienvenida

- H1: "Bienvenido a Showly, {clinicName}"
- Sub: "Vamos a configurar tu agenda en 5 pasos. Toma unos 5 minutos." (pratfall/honesty)
- 6 cards de tipo de clínica con icono Lucide (`Tooth`, `Sparkles`, `Stethoscope`, `Activity`,
  `Brain`, `MoreHorizontal`). Selección + auto-avance.
- Sub-card con checkbox "También podemos cargar 5 preguntas frecuentes por ti" (default `true`).
- CTA: "Empezar →" (56px, focus-visible ring, aria-label).
- Footer micro-copy: "En cualquier momento puedes cerrar. Guardamos tu avance."

**Validación zod**: `{ clinicType: z.enum([...]), prefillFaqs: z.boolean() }`. NO persiste
`clinicType` como campo de `Clinic` (solo en `onboardingProgress.clinicType` para elegir
templates).

### Step 2 — Primer servicio

- H1: "¿Cuál es tu servicio más común?"
- Sub: "Después puedes agregar más desde el panel."
- **Chips clickeables** (reciprocity) según `clinicType` — ej. Odontología: "Consulta de
  control", "Limpieza", "Extracción", "Endodoncia", "Blanqueamiento".
- Form:
  - `name: z.string().min(2).max(120)` — pre-llenado al clickear chip.
  - `durationMin: z.number().default(30)` — Select [15, 20, 30, 45, 60, 90, 120].
  - `priceCents: z.number().optional()` en collapse "Precio (opcional)" (progressive disclosure).
- Botones: `[← Volver] [Crear y continuar →]` — el segundo queda disabled hasta form válido.
- Endpoint: `POST /services` (existente). Guarda `serviceId` en context.

### Step 3 — Primer profesional

- H1: "¿Quién va a atender?"
- Sub: "Puede ser el dueño, un especialista o tú mismo."
- Form:
  - `name: z.string().min(2).max(120)` — pre-llenado con `me.name` (default effect).
  - Fields opcionales en collapse: `email`, `phone`, `specialty` (chips por tipo).
- **Checkbox central pre-marcado**: "También hace: {serviceName del step 2}" (default effect).
- Color picker: 6 swatches predefinidos (no color libre).
- Endpoint: `POST /professionals` + M-N con `serviceId`. Guarda `professionalId` en context.

### Step 4 — Horarios

- H1: "¿Cuándo atiendes?"
- **3 preset cards** (radio, ~100px alto):
  1. **Comercial clásico** (default checked): L-V 9-18.
  2. **Fin de semana también**: L-S 9-18.
  3. **Turno partido**: L-V 9-13 y 15-19.
- Link "Personalizar horarios" abre editor 7 días × start/end (reutiliza patrón de `panel/horarios`).
- Preview: mini calendario semanal con bloques teal (`brand-500`) — feedback visual inmediato.
- Endpoint: `POST /business-hours/bulk` (NUEVO — ver sección Backend) o `Promise.all` de POST
  individuales con rollback en cliente si alguno falla.

### Step 5 — WhatsApp

**6 estados visuales:**

| Estado           | UI                                                      | Copy                                                                                                          |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `idle`           | Card + botón "Conectar mi WhatsApp Business"           | "Escanea un QR desde tu celular. Toma ~30 segundos."                                                          |
| `starting`       | Skeleton shimmer del QR                                 | "Preparando conexión..."                                                                                      |
| `qr-visible`     | QR 280×280 + instrucciones 1-2-3                        | "(1) Abre WhatsApp Business (2) Menú → Dispositivos vinculados (3) Escanea el QR"                             |
| `qr-refreshing`  | Cross-fade 200ms sobre QR anterior (sin CLS)            | Transparente al user                                                                                          |
| `connected`      | ✅ Card verde + **confetti 2s** + botón "Continuar"    | "¡Tu WhatsApp está conectado! Tu bot ya puede recibir citas." **(PEAK)**                                     |
| `failed`         | Card roja + retry + link soporte                        | "No pudimos conectar. Intenta de nuevo o contáctanos."                                                        |

**Reutilizar polling**: extraer un hook `useWahaStatus(token)` desde
`apps/web/src/app/[locale]/panel/config/whatsapp/WhatsappConnectionClient.tsx` para
compartir entre onboarding y panel (ver [[../adr/0008-panel-conexion-waha-y-observabilidad|ADR 0008]]).

**Skip con fricción (loss aversion)**: botón secundario "Configurar más tarde" abre
`AlertDialog`:

- Título: "¿Estás seguro?"
- Body: "Sin WhatsApp conectado, Showly no puede recibir mensajes de tus pacientes. Puedes
  configurarlo desde Panel → Configuración → WhatsApp cuando quieras."
- Buttons: `[Volver a intentar]` (primario) `[Saltar de todos modos]` (destructive-outline).

**Sección honesta (pratfall)**: collapse "¿Cómo funciona?" con copy transparente sobre WAHA
(dispositivo vinculado, no API oficial, se puede desconectar). Sube trust. Ver
[[../adr/0002-waha-no-oficial|ADR 0002]] para el racional de WAHA.

**Timeout**: si `starting` > 30s → toast "Está tardando más de lo normal" + retry manual. Log
`event=onboarding.waha.slow`.

### Step 5.5 — Celebration (post-WORKING)

- Confetti 2s (canvas-confetti dinámico con `import()`, respeta `prefers-reduced-motion` → si
  reducido, solo checkmark animado).
- H1: "¡Todo listo, {name}!" Sub: "Tu clínica {clinicName} está en línea."
- Card destacado con URL pública `showly.tech/agendar/{slug}` + botón "Copiar link"
  (endowment: tienen algo tangible).
- CTA principal: "Ir al panel →".

## Componentes nuevos

### `<Stepper>` (no existe en repo)

```ts
interface StepperProps {
  steps: { id: number; label: string; done: boolean; current: boolean }[];
  onStepClick?: (id: number) => void; // solo hacia atrás
}
```

- Mobile: horizontal scroll con snap, labels solo del actual.
- Desktop: horizontal fijo arriba, línea de progreso animada 300ms.
- A11y: `role="progressbar"`, `aria-valuenow`, cada step es `<button>` navegable con teclado.
- Colors: pending `slate-300`, current `brand-500` filled + ring, done `brand-500` con check
  (contrast ≥ 4.5:1).

### `<ProgressBar>` (nuevo)

```ts
interface ProgressBarProps {
  value: number; // 0-100
  label?: string; // "2 de 5 pasos (40%)"
}
```

Barra teal (`brand-500`) sobre track `slate-100`. Transición `width` 300ms. Label a la derecha
con porcentaje — **goal-gradient explícito**.

### `<OnboardingShell>` (client)

Sticky header (logo + progress + "Guardar y salir") + main content + footer con `[← Volver]
[Skip?] [Continuar →]`. El footer real vive dentro de cada step para que el submit sea del
step-owner.

### `OnboardingContext` (client provider)

```ts
interface OnboardingState {
  clinicType: ClinicType | null;
  prefillFaqs: boolean;
  serviceId: string | null;
  professionalId: string | null;
  hoursPreset: 'weekdays-9-18' | 'saturday-included' | 'split-shift' | 'custom' | null;
  wahaStatus: WahaStatus;
  patchProgress: (partial: Partial<OnboardingState>) => Promise<void>; // debounced 500ms
  goToStep: (step: number) => void;
}
```

- Persist debouncer: 500ms → `PATCH /clinics/me/onboarding`.
- Hidrata desde `me.clinic.onboardingProgress` (SSR).
- LocalStorage NO como fuente de verdad; solo cache offline emergency (TTL 24h, key
  `showly_onboarding_cache_{clinicId}`).

## Persistencia (backend)

### Migration Prisma nueva

Archivo sugerido: `apps/backend/prisma/migrations/{ts}_clinic_onboarding_state/migration.sql`.

Cambios en `model Clinic`:

```prisma
onboardingCompletedAt DateTime?
onboardingProgress    Json?
```

**Backfill crítico** (para no mostrar el wizard a clínicas ya activas):

```sql
UPDATE "Clinic"
SET "onboardingCompletedAt" = NOW()
WHERE id IN (SELECT DISTINCT "clinicId" FROM "Service");
```

Rationale de dos columnas:

- `onboardingCompletedAt` = señal boolean barata para middleware + `/auth/me`.
- `onboardingProgress` = JSON abierto para iterar steps sin migration futura.

### Endpoint nuevo: `PATCH /clinics/me/onboarding`

```
Body: { progress?: Json; step?: number; completed?: boolean }
Response: { onboardingCompletedAt: string | null; onboardingProgress: Json }
Roles: CLINIC_ADMIN (SUPERADMIN puede con ?clinicId= override)
Guard: RolesGuard + tenantWhere
```

- Merge shallow del `progress` (no overwrite completo).
- Si `completed === true`, setea `onboardingCompletedAt = new Date()` (idempotente).
- Log: `onboarding.progress` con `{ clinicId, step, completed }` — sin PII.

### Extender `GET /auth/me`

Añadir al select del clinic snapshot:

- `onboardingCompletedAt`
- `onboardingProgress`

Referencia: patrón en `apps/backend/src/clinics/clinics.controller.ts` (endpoint `/me`).

### Endpoint opcional pero recomendado: `POST /business-hours/bulk`

Body: `{ hours: CreateBusinessHourDto[] }`. Wrapper en transacción Prisma que crea N rows
atómicamente. Evita el problema del step 4 (5-7 POST separados con posible fallo parcial).

## Templates y defaults

### `serviceTemplates.ts`

```ts
export const SERVICE_TEMPLATES: Record<ClinicType, Array<{ name: string; durationMin: number }>> = {
  dentistry: [
    { name: 'Consulta de control', durationMin: 30 },
    { name: 'Limpieza dental', durationMin: 45 },
    { name: 'Extracción', durationMin: 60 },
    { name: 'Endodoncia', durationMin: 90 },
    { name: 'Blanqueamiento', durationMin: 60 },
  ],
  aesthetics: [/* 5 items: limpieza facial, masaje, depilación, bótox, peeling */],
  general_medicine: [/* 4 items: consulta médica, control, certificado, vacunación */],
  physiotherapy: [/* 3 items: sesión kinesiología, evaluación inicial, reeducación postural */],
  psychology: [/* 3 items: primera consulta, sesión individual, sesión de pareja */],
  other: [],
};
```

### `hourPresets.ts`

```ts
export const HOUR_PRESETS = {
  'weekdays-9-18': {
    label: 'Lunes a viernes, 9 a 18',
    rows: [1, 2, 3, 4, 5].map((w) => ({ weekday: w, startMinutes: 540, endMinutes: 1080 })),
  },
  'saturday-included': {
    label: 'Lunes a sábado, 9 a 18',
    rows: [1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, startMinutes: 540, endMinutes: 1080 })),
  },
  'split-shift': {
    label: 'Lunes a viernes, mañana y tarde',
    rows: [1, 2, 3, 4, 5].flatMap((w) => [
      { weekday: w, startMinutes: 540, endMinutes: 780 }, // 9-13
      { weekday: w, startMinutes: 900, endMinutes: 1140 }, // 15-19
    ]),
  },
};
```

### `faqTemplates.ts`

8 FAQs por tipo de clínica. Título + content con placeholders `{ADDRESS}`, `{PHONE}` que se
resuelven al momento de crear. Tras completar step 2 (si `prefillFaqs === true`), disparar
`Promise.allSettled(8 × POST /faq)`. Errores parciales tolerables (log, no bloquea).

Consideración RAG: si `OPENAI_API_KEY` no está, los FAQ se crean sin embedding — el bot cae al
handoff en preguntas de conocimiento (ver [[2026-08-09-rag-faq|nota RAG FAQ]] y
[[../adr/0009-faq-title-y-markdown-strip|ADR 0009]]).

## Widget Zeigarnik en dashboard

Si `me.clinic.onboardingCompletedAt === null` y el user llega a `/panel/dashboard` (por
"Guardar y salir" o skip):

Card sticky en top de `panel/dashboard/page.tsx`:

- Icon: progress ring teal con porcentaje calculado.
- H3: "Completa tu configuración ({X}%)"
- Sub: "Te quedan {N} pasos para que tu bot esté 100% funcional"
- Mini checklist: ✓ Servicio · ✓ Profesional · ✓ Horarios · ⃝ WhatsApp
- CTA: "Continuar →" (deep-link al primer step incompleto)
- "×" dismissible per-session (localStorage flag) — vuelve a aparecer en próximo login
  (Zeigarnik pull mantiene la tensión).

Componente nuevo: `apps/web/src/app/[locale]/panel/dashboard/OnboardingProgressCard.tsx`
renderizado condicionalmente en `page.tsx`.

## i18n

Namespace nuevo `onboarding.*` en `apps/web/messages/es.json` y `apps/web/messages/pt.json`.
Copy en **español latam neutral con tú** (ver memoria personal, no rioplatense en producto).

Estructura (extracto):

```json
"onboarding": {
  "shell": {
    "saveAndExit": "Guardar y salir",
    "progress": "{current} de {total} pasos ({percent}%)",
    "back": "Volver",
    "next": "Continuar"
  },
  "step1": {
    "title": "Bienvenido a Showly, {clinicName}",
    "subtitle": "Vamos a configurar tu agenda en 5 pasos. Toma unos 5 minutos.",
    "clinicType": {
      "question": "¿Qué tipo de clínica es?",
      "dentistry": "Odontología",
      "aesthetics": "Estética",
      "generalMedicine": "Medicina general",
      "physiotherapy": "Kinesiología",
      "psychology": "Psicología",
      "other": "Otro"
    },
    "prefillFaqs": "También podemos cargar 5 preguntas frecuentes por ti",
    "cta": "Empezar"
  },
  "step2": {
    "title": "¿Cuál es tu servicio más común?",
    "suggestions": "Sugerencias",
    "name": "Nombre del servicio",
    "duration": "Duración"
  },
  "step3": {
    "title": "¿Quién va a atender?",
    "linkService": "También hace: {serviceName}"
  },
  "step4": {
    "title": "¿Cuándo atiendes?",
    "presets": {
      "weekdays": "Comercial clásico",
      "saturdayIncluded": "Fin de semana también",
      "splitShift": "Turno partido"
    }
  },
  "step5": {
    "title": "Conecta tu WhatsApp Business",
    "instructions": {
      "1": "Abre WhatsApp Business en tu celular",
      "2": "Ve a Menú → Dispositivos vinculados",
      "3": "Toca 'Vincular un dispositivo' y escanea el QR"
    },
    "connected": "¡Tu WhatsApp está conectado!",
    "connectedSubtitle": "Tu bot ya puede recibir citas de tus pacientes.",
    "later": "Configurar más tarde",
    "confirmSkip": {
      "title": "¿Estás seguro?",
      "body": "Sin WhatsApp conectado, Showly no puede recibir mensajes de tus pacientes.",
      "stay": "Volver a intentar",
      "leave": "Saltar de todos modos"
    }
  },
  "celebration": {
    "title": "¡Todo listo, {name}!",
    "subtitle": "Tu clínica {clinicName} está en línea.",
    "goToPanel": "Ir al panel",
    "copyLink": "Copiar link de agendamiento"
  },
  "dashboardWidget": {
    "title": "Completa tu configuración ({percent}%)",
    "subtitle": "Te quedan {n, plural, one {# paso} other {# pasos}} para que tu bot esté 100% funcional",
    "continue": "Continuar"
  }
}
```

## Archivos críticos a crear/modificar

**Crear:**

- `apps/web/src/app/[locale]/onboarding/**` (layout + 5 steps + shell + context + templates)
- `apps/web/src/components/ui/stepper.tsx` (nuevo shadcn-compatible)
- `apps/web/src/components/ui/progress-bar.tsx` (nuevo)
- `apps/web/src/app/[locale]/panel/dashboard/OnboardingProgressCard.tsx`
- `apps/web/src/hooks/useWahaStatus.ts` (extraído del panel actual)
- `apps/backend/prisma/migrations/{ts}_clinic_onboarding_state/migration.sql` (con backfill)

**Modificar:**

- `apps/backend/prisma/schema.prisma` — agregar `onboardingCompletedAt` + `onboardingProgress` a `Clinic`
- `apps/backend/src/clinics/clinics.controller.ts` — agregar `PATCH /me/onboarding`, extender select de `/me`
- `apps/backend/src/auth/auth.controller.ts` — extender `/auth/me` con onboarding fields
- `apps/backend/src/business-hours/business-hours.controller.ts` — agregar `POST /bulk` (opcional recomendado)
- `apps/web/src/middleware.ts` — agregar regla cookie hint + redirect a `/onboarding`
- `apps/web/src/app/[locale]/panel/layout.tsx` — re-setear cookie `showly_onboarding` desde `/auth/me`
- `apps/web/src/app/[locale]/login/LoginForm.tsx` — setear cookie hint post-login
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx` — condicional render de `OnboardingProgressCard`
- `apps/web/src/app/[locale]/panel/config/whatsapp/WhatsappConnectionClient.tsx` — refactor para consumir `useWahaStatus` extraído
- `apps/web/messages/es.json` + `apps/web/messages/pt.json` — namespace `onboarding.*`

**Referencia (no modificar, solo consultar):**

- `apps/web/src/components/ui/tokens.ts` — usar colores brand navy/teal
  (ver [[2026-08-11-brand-kit-showly|brand kit de Showly]])
- `apps/web/src/app/[locale]/panel/leads/LeadsClient.tsx` — patrón SSR + hydration + TanStack Query
- `apps/web/src/lib/query-client.ts` — TanStack defaults
- `docs/onboarding-clinica.md` — playbook manual actual (para referencia semántica del flujo)

## Roadmap de implementación (orden con dependencias)

1. **Migration Prisma + backfill** — sin esto nada persiste.
2. **Backend**: `PATCH /clinics/me/onboarding` + extender `/auth/me`.
3. **Middleware Next + cookie hint** en login handler.
4. **Componentes base**: `<Stepper>`, `<ProgressBar>`, `<OnboardingShell>`, `OnboardingContext`.
5. **Templates**: `serviceTemplates.ts`, `hourPresets.ts`, `faqTemplates.ts`.
6. **Steps 1-4** (Welcome, Service, Professional, Hours) con forms + POST al backend.
7. **Step 5 WhatsApp**: extraer `useWahaStatus` hook + UI de 6 estados + confetti dinámico.
8. **StepCelebration + `OnboardingProgressCard` en dashboard**.
9. **i18n**: llenar keys ES + PT.
10. **`POST /business-hours/bulk`** (opcional pero recomendado).
11. **Tests unit + smoke E2E**.
12. **Métricas / logging**.

Estimación: **3-4 días de dev focused** (1 dev senior).

## Verificación end-to-end

**Smoke manual (obligatorio antes de merge):**

1. `pnpm infra:up && pnpm dev:backend && pnpm dev:web`.
2. Crear clínica nueva sin `Service` via Prisma Studio + user CLINIC_ADMIN (bcrypt del password).
3. Login → verificar redirect automático a `/es/onboarding/1`.
4. Completar steps 1-4 usando templates.
5. Verificar en DB: `Service`, `Professional`, `BusinessHour` creados correctamente con
   `clinicId` correcto.
6. En step 5: escanear QR con WhatsApp Business real (o mockear WAHA) → verificar transición
   a `connected` + confetti.
7. Verificar `onboardingCompletedAt` seteado en DB + cookie `showly_onboarding=done`.
8. Redirect a `/panel/dashboard` — sin widget Zeigarnik visible.

**Smoke abandonment path:**

1. Repetir 1-3, completar solo steps 1-2, click "Guardar y salir".
2. Verificar redirect a `/panel/dashboard` + widget "Completa tu configuración (40%)" visible.
3. Click "Continuar →" → debe llevar al step 3 exacto.

**Multi-device:**

1. Iniciar onboarding en desktop hasta step 3.
2. Refresh en móvil → mismo estado (hidratado desde server).

**Accesibilidad:**

- Navegación completa con Tab (sin ratón) en cada step.
- Lighthouse accessibility score ≥ 95 en cada step.
- `prefers-reduced-motion` desactiva confetti + transiciones > 150ms.
- Viewport 360×640: todos los CTAs ≥ 44px, no overflow horizontal.

**Tests automatizados:**

- Unit (Vitest): `serviceTemplates.test.ts`, `hourPresets.test.ts`, `OnboardingContext.test.tsx`.
- Backend (Jest): extender `clinics.controller.spec.ts` con test de `PATCH /me/onboarding`
  (roles, idempotencia, multi-tenant isolation — ver
  [[../adr/0006-panel-mvp-y-deuda|ADR 0006]] sobre patrones de tenant safety).
- E2E (Playwright via MCP): flow smoke completo mockeando WAHA.

**Métricas post-deploy** (con Logger existente, event names JSON):

- `onboarding.step.viewed` — funnel visual.
- `onboarding.step.completed` con `durationMs`.
- `onboarding.step.skipped` con `reason`.
- `onboarding.completed` con `totalDurationMs` + `wahaConnected: boolean`.
- `onboarding.waha.slow` cuando starting > 30s.

KPIs a monitorear:

- **Time-to-first-service:** login → primer `POST /services` ok — target < 90s.
- **Time-to-WhatsApp-connected:** target < 5min.
- **Completion rate 7d:** target > 70% de admins nuevos llegan a `onboardingCompletedAt`.
- **Drop-off por step:** alertar si un step tiene > 30% drop vs anterior.
- **Template adoption rate:** % de servicios creados vía chip vs input libre.

## Riesgos y trade-offs anotados

- **Cookie hint puede quedar stale** con 2 tabs. Mitigación: `panel/layout.tsx` re-lee
  `/auth/me` y re-setea la cookie. Peor caso: 1 redirect innecesario, no rompe nada.
- **Backfill del migration** — si hay clínicas manualmente creadas sin `Service`, verán el
  wizard. Validar con SUPERADMIN antes de deploy.
- **WAHA falla en producción y bloquea al 100% de admins nuevos** — por eso el skip existe
  con fricción, pero **sin fricción extra** si el `POST /start` devuelve 502 (ahí el skip es
  un botón normal, no destructive-outline). Ver [[../adr/0002-waha-no-oficial|ADR 0002]].
- **Templates hardcoded** — no editables por SUPERADMIN. Admin UI de templates es v2 explícito.
- **Nueva ruta `/onboarding` fuera de `/panel`** — deliberado: distinto layout, distinto
  guard, distinto branding. No confundir usuario con sidebar del panel a medio-cargar.
- **v2 self-service creation:** cuando SUPERADMIN habilite auto-registro, el wizard actual se
  extiende con un **step 0 opcional** ("Crear tu clínica") sin refactor del shell.
  Arquitectura lista.

## Notas relacionadas

- [[../onboarding-clinica|Playbook manual actual]] — flujo de 45 min operado por Showly.
- [[../adr/0005-auth-mvp-y-deuda|ADR 0005 — Auth MVP y deuda]] — por qué la creación de
  clínica/usuario es manual hoy y qué falta para self-service.
- [[../adr/0008-panel-conexion-waha-y-observabilidad|ADR 0008 — Panel conexión WAHA]] —
  base del hook `useWahaStatus` a extraer.
- [[../adr/0002-waha-no-oficial|ADR 0002 — WAHA no oficial]] — racional del copy honesto en
  step 5.
- [[../adr/0009-faq-title-y-markdown-strip|ADR 0009 — FAQ title + strip]] — restricciones al
  crear FAQs desde templates.
- [[2026-08-11-brand-kit-showly|Brand kit de Showly]] — paleta y tokens a usar en el wizard.
- [[2026-08-09-bloque-waha-panel-conexion|Bloque WAHA panel]] — implementación del panel de
  conexión que se reutiliza.
- [[../smoke-e2e|Smoke E2E]] — checklist pre-demo, se extenderá con smoke del onboarding.
