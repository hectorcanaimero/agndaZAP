'use client';

import { useEffect } from 'react';
import { writeOnboardingHint } from '@/lib/auth';

interface Props {
  /**
   * ISO string del onboardingCompletedAt (o null si pending). Se serializa a
   * string para pasar limpio desde el server component sin drama de Date.
   */
  onboardingCompletedAt: string | null;
  /** Si es PROFESSIONAL, forzamos 'done' — nunca ven el wizard. */
  isProfessional: boolean;
}

/**
 * Re-sincroniza la cookie hint `showly_onboarding` en cada carga del panel
 * a partir del snapshot server-side de /auth/me. Cubre el edge case donde:
 * - El user completó el onboarding en otro tab → su cookie quedó `pending`
 *   pero la DB dice `done`. Este effect la corrige antes de la próxima
 *   navigation, evitando un redirect innecesario al wizard.
 * - El SUPERADMIN reseteó el estado via SQL → misma corrección al revés.
 *
 * Es UX-only: el backend siempre re-valida. Si Redis/DB reportan otra cosa,
 * el próximo /auth/me lo trae y este effect actualiza.
 */
export function OnboardingHintSync({
  onboardingCompletedAt,
  isProfessional,
}: Props) {
  useEffect(() => {
    const shouldBeDone = isProfessional || onboardingCompletedAt !== null;
    writeOnboardingHint(shouldBeDone ? 'done' : 'pending');
  }, [onboardingCompletedAt, isProfessional]);

  return null;
}
