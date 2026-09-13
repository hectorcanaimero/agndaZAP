'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

// Calculadora del costo de los no-shows. El número lo arma el visitante con
// sus propios datos: no afirmamos ninguna cifra de mercado (PRODUCT.md) y el
// resultado queda anclado para cuando lea el precio del piloto.
//
// Semanas por mes = 52/12. Los valores iniciales son editables y la nota lo
// dice; no son estadísticas.
const WEEKS_PER_MONTH = 52 / 12;

interface Field {
  key: 'weekly' | 'rate' | 'value';
  min: number;
  max: number;
  step: number;
  initial: number;
}

const FIELDS: Field[] = [
  { key: 'weekly', min: 10, max: 400, step: 5, initial: 80 },
  { key: 'rate', min: 1, max: 40, step: 1, initial: 12 },
  { key: 'value', min: 5, max: 300, step: 5, initial: 35 },
];

export function NoShowCalculator() {
  const t = useTranslations('landing.problem.calc');
  const locale = useLocale();
  const baseId = useId();
  const [values, setValues] = useState<Record<Field['key'], number>>(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, f.initial])) as Record<Field['key'], number>,
  );

  const nf = new Intl.NumberFormat(locale === 'pt' ? 'pt-BR' : 'es-419', { maximumFractionDigits: 0 });
  const lostMonth = Math.round(values.weekly * (values.rate / 100) * WEEKS_PER_MONTH);
  const moneyMonth = lostMonth * values.value;
  const currency = t('currency');

  const display = (f: Field) =>
    f.key === 'rate'
      ? `${values.rate}%`
      : f.key === 'value'
        ? `${currency} ${nf.format(values.value)}`
        : nf.format(values.weekly);

  return (
    <div className="rounded-2xl border border-mist-200 bg-white p-6 sm:p-8">
      <h3 className="text-lg font-semibold text-brand-navy">{t('title')}</h3>

      <div className="mt-6 space-y-6">
        {FIELDS.map((f) => {
          const id = `${baseId}-${f.key}`;
          return (
            <div key={f.key}>
              <div className="flex items-baseline justify-between gap-4">
                <label htmlFor={id} className="text-sm font-medium text-mist-700">
                  {t(f.key)}
                </label>
                <output htmlFor={id} className="text-base font-semibold tabular-nums text-brand-navy">
                  {display(f)}
                </output>
              </div>
              <input
                id={id}
                type="range"
                min={f.min}
                max={f.max}
                step={f.step}
                value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
                className="mt-3 h-2 w-full cursor-pointer accent-brand-navy"
              />
            </div>
          );
        })}
      </div>

      <div className="mt-8 border-t border-mist-200 pt-6" aria-live="polite">
        <p className="text-4xl font-semibold tracking-[-0.03em] tabular-nums text-brand-navy sm:text-5xl">
          {currency} {nf.format(moneyMonth)}
        </p>
        <p className="mt-1 text-sm text-mist-600">{t('moneyMonth')}</p>
        <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-mist-600">{t('lostMonth')}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-brand-navy">{nf.format(lostMonth)}</dd>
          </div>
          <div>
            <dt className="text-mist-600">{t('moneyYear')}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums text-brand-navy">
              {currency} {nf.format(moneyMonth * 12)}
            </dd>
          </div>
        </dl>
        <p className="mt-5 text-xs leading-relaxed text-mist-600">{t('note')}</p>
      </div>
    </div>
  );
}
