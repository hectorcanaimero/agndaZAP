import { redirect } from 'next/navigation';
import { fetcher, getTokenFromCookies, type AuthMe } from '@/lib/auth';

/**
 * Root del wizard. Sin URL param, decide a qué step mandar al user:
 * - Si ya completó y viene con `?rerun=1`, arranca en step 1.
 * - Si `onboardingProgress.currentStep` existe, retoma ahí.
 * - Default: step 1 (welcome).
 */
export default async function OnboardingRoot({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ rerun?: string }>;
}) {
  const { locale } = await params;
  const { rerun } = (await searchParams) ?? {};

  const token = await getTokenFromCookies();
  const meRes = await fetcher<AuthMe>('/api/auth/me', { token });

  let targetStep = 1;
  if (meRes.ok && rerun !== '1') {
    const progress = meRes.data.clinic?.onboardingProgress as
      | { currentStep?: number }
      | null;
    if (progress?.currentStep && progress.currentStep >= 1 && progress.currentStep <= 5) {
      targetStep = progress.currentStep;
    }
  }

  redirect(`/${locale}/onboarding/${targetStep}`);
}
