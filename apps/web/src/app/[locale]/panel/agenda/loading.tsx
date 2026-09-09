import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton con el patrón de la agenda: header + toolbar + grid mensual. */
export default async function AgendaLoading() {
  const t = await getTranslations('common');
  return (
    <div className="w-full space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t('loading')}</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <Skeleton className="h-11 w-24" />
            <Skeleton className="h-11 w-20" />
            <Skeleton className="ml-2 h-7 w-44" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-11 w-56" />
            <Skeleton className="h-11 w-32" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <Skeleton className="h-11 w-28" />
          <Skeleton className="h-11 w-full max-w-[320px] flex-1" />
          <Skeleton className="h-11 w-44 sm:w-56" />
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-border bg-border">
        {Array.from({ length: 35 }).map((_, i) => (
          <div key={i} className="min-h-[88px] bg-card p-2">
            <Skeleton className="h-4 w-5" />
          </div>
        ))}
      </div>
    </div>
  );
}
