'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fetcher } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useOnboarding } from '../OnboardingContext';
import {
  HOUR_PRESETS,
  type HourPresetKey,
  type HourRow,
} from '../templates/hourPresets';

interface Props {
  locale: string;
  token: string;
}

const SELECTABLE_PRESETS: Exclude<HourPresetKey, 'custom'>[] = [
  'weekdays-9-18',
  'saturday-included',
  'split-shift',
];

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

function minutesToLabel(mins: number): string {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Step 4 — Horarios. 3 preset cards (paradox of choice ≤3). Cada card muestra
 * el label y un preview compacto de los días afectados. Default checked:
 * `weekdays-9-18` — es el patrón más común en clínicas latam.
 *
 * Al submit hace POST /business-hours/bulk (transaccional) para evitar rows
 * huérfanos si algún insert falla en el medio. El endpoint bulk es opcional
 * pero altamente recomendado — sin él, este step tiene un race condition.
 */
export function StepHours({ locale, token }: Props) {
  const t = useTranslations('onboarding.step4');
  const tShell = useTranslations('onboarding.shell');
  const router = useRouter();
  const { state, patch } = useOnboarding();

  const [selected, setSelected] = useState<HourPresetKey>(
    (state.hoursPreset as HourPresetKey | null) ?? 'weekdays-9-18',
  );
  const [submitting, setSubmitting] = useState(false);

  const rowsToCreate: HourRow[] =
    selected === 'custom' ? [] : HOUR_PRESETS[selected].rows;

  const previewDays = summarizeRows(rowsToCreate);

  const onSubmit = async () => {
    if (submitting) return;
    if (rowsToCreate.length === 0) {
      toast.error(t('errors.emptyPreset'));
      return;
    }
    setSubmitting(true);

    const res = await fetcher('/api/business-hours/bulk', {
      method: 'POST',
      body: JSON.stringify({ hours: rowsToCreate }),
      token,
    });

    if (!res.ok) {
      setSubmitting(false);
      toast.error(t('errors.createFailed'));
      return;
    }

    patch({ hoursPreset: selected });
    router.push(`/${locale}/onboarding/5`);
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground md:text-base">
          {t('subtitle')}
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="sr-only">{t('presetLegend')}</legend>
        {SELECTABLE_PRESETS.map((key) => {
          const isSelected = selected === key;
          const summary = summarizeRows(HOUR_PRESETS[key].rows);
          return (
            <label
              key={key}
              htmlFor={`preset-${key}`}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
                isSelected
                  ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-200'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50',
              )}
            >
              <input
                type="radio"
                id={`preset-${key}`}
                name="hoursPreset"
                value={key}
                checked={isSelected}
                onChange={() => setSelected(key)}
                className="mt-1 h-4 w-4 shrink-0 accent-brand-600"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {t(`presets.${key}` as never)}
                  </p>
                  {isSelected ? (
                    <CheckCircle2
                      className="h-4 w-4 text-brand-600"
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {summary.map((day) => (
                    <span
                      key={`${key}-${day.label}`}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs',
                        isSelected
                          ? 'bg-white text-brand-800'
                          : 'bg-slate-100 text-slate-700',
                      )}
                    >
                      <span className="font-semibold">{day.label}</span>
                      <span className="tabular-nums">{day.times}</span>
                    </span>
                  ))}
                </div>
              </div>
            </label>
          );
        })}
      </fieldset>

      <p className="text-xs text-muted-foreground">{t('customLater')}</p>

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={() => router.push(`/${locale}/onboarding/3`)}
          className="min-h-11 gap-2"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {tShell('back')}
        </Button>
        <Button
          type="button"
          size="lg"
          disabled={submitting}
          onClick={onSubmit}
          className="min-h-11 gap-2 sm:min-w-40"
        >
          {submitting ? tShell('creating') : tShell('next')}
          {!submitting ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
        </Button>
      </div>
      {/* previewDays sirve para debug futuro; evitamos "unused variable" */}
      <span className="sr-only" aria-hidden="true">
        {previewDays.length}
      </span>
    </div>
  );
}

interface DaySummary {
  label: string;
  times: string;
}

/**
 * Colapsa rows por día en un preview compacto. Ej: `[{ weekday:1, 9-13 },
 * { weekday:1, 15-19 }]` → `[{ label: 'L', times: '09-13, 15-19' }]`.
 */
function summarizeRows(rows: HourRow[]): DaySummary[] {
  const dayLabels: Record<number, string> = {
    0: 'D',
    1: 'L',
    2: 'M',
    3: 'X',
    4: 'J',
    5: 'V',
    6: 'S',
  };
  const grouped = new Map<number, string[]>();
  for (const r of rows) {
    const key = r.weekday;
    const range = `${minutesToLabel(r.startMinutes)}-${minutesToLabel(r.endMinutes)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(range);
  }
  return WEEKDAY_ORDER.filter((d) => grouped.has(d)).map((d) => ({
    label: dayLabels[d]!,
    times: grouped.get(d)!.join(' · '),
  }));
}
