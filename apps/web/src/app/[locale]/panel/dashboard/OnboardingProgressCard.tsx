'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Circle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { cn } from '@/lib/utils';

interface Props {
  locale: string;
  clinicId: string;
  progress: {
    hasService: boolean;
    hasProfessional: boolean;
    hasHours: boolean;
    hasWhatsapp: boolean;
  };
}

const DISMISS_KEY_PREFIX = 'showly_onboarding_widget_dismissed_';

/**
 * Widget Zeigarnik del dashboard. Se renderiza SOLO cuando el user completó
 * parcialmente el onboarding (`onboardingCompletedAt` sigue null o skip
 * temprano) — la lógica de mostrar/ocultar vive en `page.tsx`.
 *
 * Aplica Zeigarnik effect (tareas incompletas ocupan la mente): checklist
 * visual + porcentaje + deep-link al primer step incompleto. Dismissible
 * per-session (localStorage con clinicId como scope) para no ser molesto,
 * pero vuelve a aparecer en el próximo login.
 */
export function OnboardingProgressCard({ locale, clinicId, progress }: Props) {
  const t = useTranslations('onboarding.dashboardWidget');
  const [dismissed, setDismissed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = `${DISMISS_KEY_PREFIX}${clinicId}`;
    setDismissed(sessionStorage.getItem(key) === '1');
    setReady(true);
  }, [clinicId]);

  const handleDismiss = () => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(`${DISMISS_KEY_PREFIX}${clinicId}`, '1');
    }
    setDismissed(true);
  };

  if (!ready || dismissed) return null;

  const items: Array<{ key: string; done: boolean; label: string }> = [
    { key: 'service', done: progress.hasService, label: t('items.service') },
    {
      key: 'professional',
      done: progress.hasProfessional,
      label: t('items.professional'),
    },
    { key: 'hours', done: progress.hasHours, label: t('items.hours') },
    {
      key: 'whatsapp',
      done: progress.hasWhatsapp,
      label: t('items.whatsapp'),
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const totalCount = items.length;
  const percent = Math.round((doneCount / totalCount) * 100);

  return (
    <div className="rounded-lg border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold text-foreground">
            {t('title', { percent })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('subtitle', { n: totalCount - doneCount })}
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('dismiss')}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-slate-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-3">
        <ProgressBar value={percent} label={null} />
      </div>

      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-2">
            {item.done ? (
              <CheckCircle2
                className="h-4 w-4 shrink-0 text-brand-600"
                aria-hidden="true"
              />
            ) : (
              <Circle
                className="h-4 w-4 shrink-0 text-slate-400"
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                'min-w-0 truncate',
                item.done
                  ? 'text-muted-foreground line-through'
                  : 'text-foreground',
              )}
            >
              {item.label}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <Button asChild size="sm" className="gap-1.5">
          <Link href={`/${locale}/onboarding`}>
            {t('continue')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
