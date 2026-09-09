import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton con el patrón de la bandeja: header + split lista/chat. */
export default async function ConversationsLoading() {
  const t = await getTranslations('common');
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">{t('loading')}</span>
      <div className="shrink-0 space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[320px_1fr]">
        <div className="space-y-2 rounded-xl border border-border bg-card p-3 shadow-sm">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-2">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="hidden flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm md:flex">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-10 w-3/5 rounded-2xl" />
          <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
          <Skeleton className="h-10 w-2/5 rounded-2xl" />
          <Skeleton className="mt-auto h-11 w-full" />
        </div>
      </div>
    </div>
  );
}
