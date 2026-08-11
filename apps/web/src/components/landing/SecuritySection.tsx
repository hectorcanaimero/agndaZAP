import { useTranslations } from 'next-intl';
import { Users2, Lock, EyeOff, KeyRound } from 'lucide-react';

// SecuritySection — vertical clinicas, la barrera #1 en el pitch es "¿qué
// hacen con los datos de mis pacientes?". La respuesta tiene que ser honesta
// y CHEQUEABLE contra el código, no un listado de logos de compliance que no
// tenemos (piloto → no hay HIPAA/SOC2/ISO). Cada pilar de abajo mapea a un
// hecho verificable del backend:
//   - isolation → `clinicId` en todas las entidades (schema.prisma) +
//     patrón `tenantWhere(user, clinicIdOverride)` usado en TODOS los
//     controllers del panel (services.controller.ts L18, L66).
//   - dedicated → `wahaSession String @unique` en Clinic (schema L23):
//     cada tenant corre su propia instancia WAHA.
//   - noPii     → rate-limit.guard.ts L119-122 loguea sólo IP + status;
//     public.controller.ts L199, L253 nunca deja pasar phone/name al log
//     ni a la response. leads.service.ts L41-44 mismo patrón.
//   - accessControl → JwtAuthGuard GLOBAL (auth.module.ts L40-42) — deny
//     by default; cada ruta pública se opt-outea con @Public(). Panel
//     protegido por RolesGuard (services.controller.ts L34-35).
//
// Diseño:
//   - Fondo `bg-neutral-900 text-white`: rompe el patrón blanco/gris de las
//     secciones vecinas (ForWhom bg-white, FaqSection bg-neutral-50) y le
//     da peso visual — el mismo tratamiento que Testimonial. Le dice al
//     visitante "esto es importante, prestá atención".
//   - Grid 2×2 (md+) / 4×1 (mobile). Peso similar a Features/Pricing.
//   - SIN CTA propio para no fragmentar el funnel — ya hay CTAs en Pricing
//     y FinalCta. Esta sección INFORMA, no vende.
//   - Icono en badge redondeado como en HowItWorks/Features, adaptado al
//     fondo oscuro (bg-white/5 + text-white).
const PILLARS = [
  { key: 'isolation', Icon: Users2 },
  { key: 'dedicated', Icon: Lock },
  { key: 'noPii', Icon: EyeOff },
  { key: 'accessControl', Icon: KeyRound },
] as const;

export function SecuritySection() {
  const t = useTranslations('landing.security');

  return (
    <section id="security" className="bg-neutral-900 py-20 text-white lg:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <span className="text-xs font-medium uppercase tracking-widest text-brand-300">
            {t('eyebrow')}
          </span>
          <h2
            className="mt-3 font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl lg:text-5xl"
            style={{ overflowWrap: 'anywhere' }}
          >
            {t('headline')}
          </h2>
          <p className="mt-4 text-base text-neutral-300 sm:text-lg">
            {t('subheadline')}
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:mt-16 lg:gap-6">
          {PILLARS.map(({ key, Icon }) => (
            <article
              key={key}
              className="group relative min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors hover:border-white/20 hover:bg-white/[0.05] lg:p-8"
            >
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-white ring-1 ring-inset ring-white/10">
                <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
              </div>
              <h3 className="mt-5 text-base font-semibold text-white">
                {t(`pillars.${key}.title`)}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-300">
                {t(`pillars.${key}.body`)}
              </p>
            </article>
          ))}
        </div>

        <p className="mt-10 max-w-2xl text-sm text-neutral-400 lg:mt-12">
          {t('footnote')}
        </p>
      </div>
    </section>
  );
}
