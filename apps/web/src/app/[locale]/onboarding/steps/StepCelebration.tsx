'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Copy, PartyPopper } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useOnboarding } from '../OnboardingContext';

interface Props {
  locale: string;
}

/**
 * Step 6 — Celebration (post-connected). Peak-end rule: el "clic" del bot
 * conectado + la clínica en línea es el momento de mayor valor percibido.
 * Anclamos memoria con animación breve + link público listo para compartir
 * (endowment: el user siente que ya tiene algo tangible).
 *
 * Respetamos `prefers-reduced-motion`: sin confetti animado, solo el
 * checkmark grande + el copy positivo. No hacemos import dinámico de
 * canvas-confetti para no sumar deps al bundle del MVP — un CSS confetti
 * simple con `data-anim` es suficiente y accesible.
 */
export function StepCelebration({ locale }: Props) {
  const t = useTranslations('onboarding.celebration');
  const router = useRouter();
  const { me } = useOnboarding();

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const shareUrlRef = useRef<string>('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReducedMotion(mq.matches);
      const listener = (e: MediaQueryListEvent) =>
        setPrefersReducedMotion(e.matches);
      mq.addEventListener('change', listener);
      return () => mq.removeEventListener('change', listener);
    }
  }, []);

  const slug = me.clinic?.slug ?? '';
  useEffect(() => {
    if (typeof window !== 'undefined' && slug) {
      shareUrlRef.current = `${window.location.origin}/${locale}/agendar/${slug}`;
    }
  }, [slug, locale]);

  const copyShareLink = async () => {
    if (!shareUrlRef.current) return;
    try {
      await navigator.clipboard.writeText(shareUrlRef.current);
      toast.success(t('linkCopied'));
    } catch {
      toast.error(t('linkCopyFailed'));
    }
  };

  return (
    <div className="flex flex-col items-center gap-8 py-8 text-center">
      <div
        className="relative flex h-24 w-24 items-center justify-center rounded-full bg-green-100 text-green-700"
        aria-hidden="true"
      >
        <PartyPopper className="h-12 w-12" />
        {!prefersReducedMotion ? (
          <>
            <span className="absolute -left-4 top-2 h-2 w-2 animate-ping rounded-full bg-brand-400" />
            <span className="absolute right-0 top-6 h-1.5 w-1.5 animate-ping rounded-full bg-yellow-400 [animation-delay:200ms]" />
            <span className="absolute -bottom-2 left-6 h-2 w-2 animate-ping rounded-full bg-pink-400 [animation-delay:400ms]" />
          </>
        ) : null}
      </div>

      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {t('title', { name: me.name })}
        </h1>
        <p className="text-sm text-muted-foreground md:text-base">
          {t('subtitle', { clinicName: me.clinic?.name ?? '' })}
        </p>
      </div>

      {slug ? (
        <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-4 text-left">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('shareLink.label')}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-slate-100 px-3 py-2 text-xs text-foreground">
              /{locale}/agendar/{slug}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyShareLink}
              className="shrink-0 gap-1.5"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {t('shareLink.copy')}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('shareLink.help')}
          </p>
        </div>
      ) : null}

      <Button
        type="button"
        size="lg"
        onClick={() => router.push(`/${locale}/panel/dashboard`)}
        className="min-h-11 gap-2 sm:min-w-52"
      >
        {t('goToPanel')}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
