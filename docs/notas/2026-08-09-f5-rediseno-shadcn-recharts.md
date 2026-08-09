# F5 — Rediseño visual con shadcn + Recharts (2026-08-09)

Cierre de la Fase 5 del rediseño de AgendaZap: las 4 pantallas grandes
(Dashboard, Agenda, Conversations, Página pública) quedaron rediseñadas con
[[docs/adr/0009-shadcn-oficial|shadcn oficial]], [[docs/adr/0011-recharts-como-charting|Recharts vía shadcn Chart]]
e iconos lucide-react.

## Componentes shadcn agregados
- `components/ui/chart.tsx` — ChartContainer + ChartTooltip + ChartTooltipContent
  (Recharts wrappers), instalado con `pnpm dlx shadcn@latest add chart`.
- `components/ui/checkbox.tsx` — Radix Checkbox para el consent del form público.
- `components/ui/scroll-area.tsx` — instalado para uso futuro (Conversations sigue
  usando `overflow-auto` porque el max-h ya está controlado).
- `components/ui/avatar.tsx` — instalado para uso futuro.

## Decisiones no obvias

### 1. `--destructive` en vez de `--chart-4` para no-show
El theme shadcn default trae `--chart-4: 43 74% 66%` (amarillo). Semánticamente
"no-show" es alerta / error → usar `hsl(var(--destructive))` da mejor comunicación
y sube contraste sobre blanco a AA. Ver `DashboardTrendChart.tsx`.

### 2. Tabs shadcn NO se usan para Día/Semana en Agenda
Consideré `<Tabs>` shadcn para el toggle Día/Semana pero descarté: el toggle
actual actualiza el query param (SSR-friendly) y los `<Tabs>` de shadcn son
estado local. Mantuvimos el segmented control custom con `role="group"` +
`aria-pressed`, pero con look pulido: fondo `bg-gray-50`, active con
`bg-white shadow-sm` (mismo tratamiento que tabs shadcn).

### 3. Sticky sidebar en /agendar
La página pública ahora tiene 2 columnas en desktop (`md:grid-cols-[320px_1fr]`)
con la info de la clínica sticky (`md:sticky md:top-8`). En mobile stack single.
Motivo: dar contexto persistente (nombre/dirección) mientras el paciente
scrollea el form largo. Reduce ansiedad de "¿estoy en el sitio correcto?".

### 4. Section headers en ScheduleForm
Dividí el form largo en 3 secciones con headers visuales (`SectionHeader`
component): Servicio → Horario → Datos. Cada uno con icono lucide + título +
descripción corta. NO es un stepper real (el form sigue siendo one-shot); es
sólo ayuda visual para dividir la información.

### 5. Preservación de UX specs ganadas
Todos los patrones críticos siguen intactos:
- `todayStartInTZ()` para `from` del fetch de slots.
- `role="alert"` + `aria-live="assertive"` en submitError.
- Foco automático al primer slot post-409 (`requestAnimationFrame` + `[data-slot]`).
- Doble submit lock (`if (isSubmitting) return`).
- Skeleton de slots (3×4 con `Skeleton` shadcn).
- Contraste 4.83:1 (bg-brand-600 + text-white) en slot seleccionado y bubble OUT.
- Auto-takeover en Conversations con hint `role="note"` orange-700 (contraste AA).
- Sample size en dashboard cards (spec `docs/ux/`).
- Filter bar mobile-collapsible en Agenda (`<details>` en `sm:hidden`).
- `<details>` + `<table>` accesible como alternativa keyboard al trend chart.

## Iconos lucide usados
- **Dashboard**: TrendingDown, CheckCircle2, PieChart, LineChart.
- **Agenda**: Clock, User, Briefcase, CalendarOff (empty state), ChevronLeft/Right,
  Filter, X.
- **Conversations**: MessageCircle (empty), Send, UserCheck (tomar),
  UserMinus (devolver), User (avatar), RefreshCw (refresh/loading).
- **Página pública**: Stethoscope, Calendar, User, MessageSquare (form sections),
  MapPin (address), Sparkles + CalendarClock (features card),
  CheckCircle2 + ArrowLeft (gracias).

## i18n keys agregadas (paridad es/pt)
- `page.poweredBy`, `page.features.title/quick/whatsapp`
- `form.sections.service/slot/patient` (title + description cada uno)
- `panel.agenda.emptyState.title/description`
- `panel.conversations.emptyList/emptyDetail`

## Verificaciones
- `pnpm build` en `apps/web`: OK sin warnings ni errores.
- Backend tests: **277/277 verdes**.
- Paridad i18n es/pt: OK (diff vacío).
- `apps/web/src/components/ui/chart.tsx` existe (shadcn Chart primitive).

## Archivos tocados
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx` — rewrite con Cards
  pulidas + iconos + delegación al chart.
- `apps/web/src/app/[locale]/panel/dashboard/DashboardTrendChart.tsx` — NUEVO,
  client component con shadcn Chart (BarChart Recharts).
- `apps/web/src/app/[locale]/panel/dashboard/LucideIcon.tsx` — NUEVO, wrapper
  server-safe para mapping name → icon.
- `apps/web/src/app/[locale]/panel/agenda/AgendaClient.tsx` — rewrite con
  iconos lucide, DayView/WeekView pulidos, empty state con `CalendarOff`,
  dialog con badge de estado destacado.
- `apps/web/src/app/[locale]/panel/conversaciones/ConversationsClient.tsx` —
  rewrite: sidebar con badges outline, bubbles chat con rounded-2xl + sombra
  sutil, avatar en header, botones con iconos, skeleton mejorado.
- `apps/web/src/app/[locale]/agendar/[clinicSlug]/page.tsx` — layout 2 columnas
  sticky, card de features.
- `apps/web/src/app/[locale]/agendar/[clinicSlug]/ScheduleForm.tsx` — rewrite
  con 3 secciones visuales, Radix Checkbox shadcn para consent, iconos por
  sección.
- `apps/web/src/app/[locale]/agendar/[clinicSlug]/gracias/page.tsx` — card
  centrado, icono verde CheckCircle2, chip con fecha/hora.
- `apps/web/src/app/[locale]/agendar/[clinicSlug]/gracias/ThanksName.tsx` —
  ajuste de spacing del título.
- `apps/web/messages/es.json` + `pt.json` — nuevas keys en paridad.

## Preguntas abiertas para F6
- ¿Vale la pena mover los tokens `TREND_CHART_COLORS` de `tokens.ts` a
  `ChartConfig`? Hoy `tokens.ts` sigue definido pero ya nadie lo consume
  (el SVG hand-rolled se removió). Candidato a limpieza en F6.
- El `Skeleton` en las bubbles del chat mejora bastante — considerar usar el
  mismo patrón para el load inicial de Agenda/Dashboard (hoy son SSR sin loader).
- La página pública podría beneficiarse de un progress indicator más explícito
  (1/3, 2/3, 3/3) si en analytics vemos drop-off en la sección de Datos.
- `avatar` y `scroll-area` shadcn instalados pero no usados aún — dejarlos para
  F6 o remover si no aportan.
