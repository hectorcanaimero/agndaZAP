import { notFound } from 'next/navigation';
import { fetcher, getTokenFromCookies, type AuthMe } from '@/lib/auth';
import { OnboardingProvider, type OnboardingState } from '../OnboardingContext';
import { OnboardingShell } from '../OnboardingShell';
import { StepCelebration } from '../steps/StepCelebration';
import { StepHours } from '../steps/StepHours';
import { StepProfessional } from '../steps/StepProfessional';
import { StepService } from '../steps/StepService';
import { StepWelcome } from '../steps/StepWelcome';
import { StepWhatsapp } from '../steps/StepWhatsapp';

const VALID_STEPS = new Set([1, 2, 3, 4, 5, 6]);

/**
 * Server component que despacha al step correspondiente según el URL param.
 * Hidrata el OnboardingProvider desde `me.clinic.onboardingProgress` y monta
 * el shell con progreso + stepper.
 *
 * Step 6 es el celebration post-connected — no cuenta en el stepper (TOTAL=5)
 * pero es una URL válida para deep-link al momento del confetti.
 */
export default async function StepPage({
  params,
}: {
  params: Promise<{ locale: string; step: string }>;
}) {
  const { locale, step: stepRaw } = await params;
  const stepNum = Number(stepRaw);
  if (!Number.isInteger(stepNum) || !VALID_STEPS.has(stepNum)) {
    notFound();
  }

  const token = await getTokenFromCookies();
  const meRes = await fetcher<AuthMe>('/api/auth/me', { token });

  if (!meRes.ok || !meRes.data.clinic) {
    // El layout ya cubre el 401. Si llegamos acá sin clinic es SUPERADMIN sin
    // clinicId — no debería estar en onboarding. `notFound` mejor que crash.
    notFound();
  }

  const me = meRes.data;
  const rawProgress = me.clinic!.onboardingProgress as
    | Partial<OnboardingState & { currentStep?: number }>
    | null;

  const initialState: OnboardingState = {
    clinicType: rawProgress?.clinicType ?? null,
    prefillFaqs: rawProgress?.prefillFaqs ?? true,
    serviceId: rawProgress?.serviceId ?? null,
    serviceName: rawProgress?.serviceName ?? null,
    professionalId: rawProgress?.professionalId ?? null,
    hoursPreset: rawProgress?.hoursPreset ?? null,
  };

  return (
    <OnboardingProvider me={me} initialState={initialState} currentStep={stepNum}>
      <OnboardingShell locale={locale}>
        {stepNum === 1 ? <StepWelcome locale={locale} /> : null}
        {stepNum === 2 ? <StepService locale={locale} token={token ?? ''} /> : null}
        {stepNum === 3 ? (
          <StepProfessional locale={locale} token={token ?? ''} />
        ) : null}
        {stepNum === 4 ? <StepHours locale={locale} token={token ?? ''} /> : null}
        {stepNum === 5 ? <StepWhatsapp locale={locale} token={token ?? ''} /> : null}
        {stepNum === 6 ? <StepCelebration locale={locale} /> : null}
      </OnboardingShell>
    </OnboardingProvider>
  );
}
