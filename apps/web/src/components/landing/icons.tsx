/*
 * Iconos hand-built SVG para la landing de gochat.
 *
 * Motivación: reemplazar el pack lucide (que se ve idéntico a cualquier otra
 * landing SaaS AI-era) por un set custom con estilo propio — trazo 1.75px,
 * corners redondeados, densidad moderada. Cada uno cuenta la historia del
 * feature/paso en vez de ser un pictograma abstracto.
 *
 * Convención: todos usan `currentColor` para heredar del contenedor,
 * viewBox uniforme 24×24, `aria-hidden` porque son decorativos (el título
 * del feature carga el semántico).
 */

type IconProps = { className?: string };

// ── Features (6) ────────────────────────────────────────────────

// Recordatorios anti no-show — bell con arco de tiempo + check
export function IconReminder({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M6 9a6 6 0 1 1 12 0v4l1.5 3h-15L6 13V9Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M10 19a2 2 0 1 0 4 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="m9.5 10.5 1.75 1.75L15 8.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Handoff a humano — dos siluetas conectadas por un enlace
export function IconHandoff({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <circle cx="7" cy="7.5" r="2.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M2.5 17c.4-2.5 2.4-4 4.5-4s4.1 1.5 4.5 4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="17" cy="7.5" r="2.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12.5 17c.4-2.5 2.4-4 4.5-4s4.1 1.5 4.5 4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M9.5 7.5h5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray="1.5 2"
      />
    </svg>
  );
}

// Base de conocimiento — libro abierto con líneas de texto
export function IconKnowledge({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M4 5c2.5 0 5.5.5 8 2 2.5-1.5 5.5-2 8-2v13c-2.5 0-5.5.5-8 2-2.5-1.5-5.5-2-8-2V5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M12 7v13"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M6.5 9h3M6.5 12h3M15 9h2.5M15 12h2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Multi-profesional — 3 avatares
export function IconMultiPro({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <circle cx="12" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M6.5 19c.5-3 2.5-5 5.5-5s5 2 5.5 5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="5" cy="9.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="19" cy="9.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2 17c.3-1.7 1.4-3 3-3M22 17c-.3-1.7-1.4-3-3-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Feedback post-atención — cinco estrellas mínimas
export function IconFeedback({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="m12 3.5 2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M4 20.5h16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="0.5 3"
      />
    </svg>
  );
}

// Multi-idioma — globo con dos guiones (representan idiomas)
export function IconMultiLang({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M3.5 12h17"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 3.5c2.5 3 2.5 14 0 17M12 3.5c-2.5 3-2.5 14 0 17"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── How it works (3) — pictogramas más ilustrativos ─────────────

// Paso 1: paciente escribe — burbuja con dedos escribiendo abajo
export function IconChatWrite({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5v-3.5H6.5A2.5 2.5 0 0 1 4 13.5v-8Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="9.5" r="0.9" fill="currentColor" />
      <circle cx="12" cy="9.5" r="0.9" fill="currentColor" />
      <circle cx="15" cy="9.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

// Paso 2: bot agenda + confirma + recuerda — calendario con check
export function IconCalendarCheck({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <rect
        x="3.5"
        y="5"
        width="17"
        height="15.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M3.5 9.5h17"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M8 2.5v4M16 2.5v4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="m8 14.5 2.5 2.5L16 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Paso 3: panel — dashboard con 3 columnas
export function IconDashboard({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M3 8.5h18"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M8 12v5M12 14v3M16 11v6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="6" cy="6.25" r="0.75" fill="currentColor" />
      <circle cx="8.5" cy="6.25" r="0.75" fill="currentColor" />
    </svg>
  );
}

// ── For whom (4) — pictogramas por tipo de clínica ──────────────

// Consultorios pequeños — 1 silla + estetoscopio
export function IconConsultorio({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M4.5 20.5V8.5A2 2 0 0 1 6.5 6.5h11a2 2 0 0 1 2 2v12"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.5V4a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 16 4v2.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M9 12.5h6M9 15.5h6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Clínicas polivalentes — edificio con cruz
export function IconClinic({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M4 20.5V7l8-4 8 4v13.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 20.5h19"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 9v6M9 12h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Estética/bienestar — hoja con brillo
export function IconWellness({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M20 4c-9 0-15 5-15 12 0 2 .5 3.5 1 4.5C7 15 12 12 20 12"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="m17 8-3 3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M18 17.5v3M16.5 19h3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Especialistas — birrete de graduación
export function IconSpecialist({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M6 11.5v4c0 1.5 2.7 3 6 3s6-1.5 6-3v-4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M20 10v5.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="20" cy="17" r="1.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
