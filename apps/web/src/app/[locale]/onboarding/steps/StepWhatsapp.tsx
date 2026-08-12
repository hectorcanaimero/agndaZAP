'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Loader2,
  QrCode,
  Smartphone,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { fetcher } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useOnboarding } from '../OnboardingContext';

interface Props {
  locale: string;
  token: string;
}

interface WahaStatusResponse {
  status: string;
  session: string;
  qr?: string;
}

/**
 * Cadence de polling adaptativo — mismo criterio que el panel de WhatsApp:
 * transitorios cortos, WORKING largo, terminal off. Ver ADR 0008.
 */
const POLL_MS: Record<string, number> = {
  STARTING: 2500,
  SCAN_QR_CODE: 2500,
  UNKNOWN: 3000,
  WORKING: 5000,
  STOPPED: 0,
  FAILED: 0,
};

const TIMEOUT_STARTING_MS = 30_000;

/**
 * Step 5 — WhatsApp. Peak del onboarding (peak-end rule): al llegar a WORKING
 * mostramos celebración inmediata + auto-avanzamos al step 6 (celebration).
 *
 * Estados visuales:
 *  - idle: card + CTA "Conectar mi WhatsApp Business"
 *  - starting: skeleton + spinner
 *  - qr-visible: QR + instrucciones 1-2-3
 *  - connected: card verde + auto-navigate a step 6 (celebration)
 *  - failed: card roja + retry
 *
 * Skip explícito con AlertDialog (loss aversion): "sin WhatsApp no vas a
 * recibir mensajes de pacientes". Botón secundario, fricción de 2 clicks.
 */
export function StepWhatsapp({ locale, token }: Props) {
  const t = useTranslations('onboarding.step5');
  const tShell = useTranslations('onboarding.shell');
  const router = useRouter();
  const { markCompleted } = useOnboarding();

  const [status, setStatus] = useState<string>('IDLE');
  const [qr, setQr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [confirmSkipOpen, setConfirmSkipOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startingSinceRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!mountedRef.current) return;
    const res = await fetcher<WahaStatusResponse>(
      '/api/clinics/me/waha/status',
      { token },
    );
    if (!mountedRef.current) return;

    if (res.ok) {
      setStatus(res.data.status);
      setQr(res.data.qr ?? null);
    } else if (res.status === 502) {
      // WAHA down — no rompemos el loop, el próximo tick puede recuperar.
      setStatus('UNKNOWN');
    } else if (res.status === 429) {
      toast.info(t('toasts.rateLimited'));
    }
  }, [token, t]);

  // Loop de polling recursivo (no setInterval, evita solapamientos).
  useEffect(() => {
    if (status === 'IDLE') return;
    const interval = POLL_MS[status] ?? 3000;
    if (interval === 0) {
      clearTimer();
      return;
    }
    clearTimer();
    timerRef.current = setTimeout(() => {
      void fetchStatus();
    }, interval);
    return clearTimer;
  }, [status, fetchStatus, clearTimer]);

  // Timeout STARTING: si no vemos QR/WORKING en 30s, damos hint sin cortar.
  useEffect(() => {
    if (status === 'STARTING') {
      if (startingSinceRef.current === null) {
        startingSinceRef.current = Date.now();
      }
      const interval = setInterval(() => {
        if (
          startingSinceRef.current !== null &&
          Date.now() - startingSinceRef.current > TIMEOUT_STARTING_MS
        ) {
          toast.info(t('toasts.slowStart'));
          startingSinceRef.current = null;
        }
      }, 5000);
      return () => clearInterval(interval);
    }
    startingSinceRef.current = null;
  }, [status, t]);

  // Auto-navigate a celebration cuando llegamos a WORKING (peak-end rule).
  useEffect(() => {
    if (status !== 'WORKING') return;
    // Delay chico para que el user vea el badge verde antes del navigate.
    const tid = setTimeout(async () => {
      if (!mountedRef.current) return;
      await markCompleted();
      router.push(`/${locale}/onboarding/6`);
    }, 900);
    return () => clearTimeout(tid);
  }, [status, markCompleted, router, locale]);

  useEffect(() => {
    mountedRef.current = true;
    // Fetch inicial para saber si ya hay sesión en algún estado.
    void fetchStatus();
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = async () => {
    if (starting) return;
    setStarting(true);
    setStatus('STARTING');
    const res = await fetcher('/api/clinics/me/waha/start', {
      method: 'POST',
      token,
    });
    if (!mountedRef.current) return;
    setStarting(false);
    if (!res.ok) {
      if (res.status === 502) {
        toast.error(t('toasts.startFailed'));
      } else if (res.status === 429) {
        toast.info(t('toasts.rateLimited'));
      } else {
        toast.error(t('toasts.startFailed'));
      }
      setStatus('FAILED');
    }
  };

  const handleSkip = async () => {
    if (skipping) return;
    setSkipping(true);
    await markCompleted();
    router.push(`/${locale}/panel/dashboard`);
  };

  const isConnected = status === 'WORKING';
  const showQr = status === 'SCAN_QR_CODE' && !!qr;
  const isStarting = status === 'STARTING' && !qr;
  const isFailed = status === 'FAILED';
  const isIdle = status === 'IDLE' || status === 'STOPPED' || status === 'UNKNOWN';

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

      {/* Estados */}
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        {isConnected ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-green-700">
              <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
            </div>
            <p className="text-lg font-semibold text-foreground">
              {t('states.connected.title')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('states.connected.subtitle')}
            </p>
          </div>
        ) : isStarting ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Loader2
              className="h-10 w-10 animate-spin text-brand-600"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-foreground">
              {t('states.starting')}
            </p>
          </div>
        ) : showQr ? (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr}
                alt={t('qr.alt')}
                width={280}
                height={280}
                className="rounded"
              />
            </div>
            <ol className="w-full max-w-md space-y-2 text-sm text-foreground">
              {[1, 2, 3].map((n) => (
                <li key={n} className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">
                    {n}
                  </span>
                  <span>{t(`instructions.${n}` as never)}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : isFailed ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-red-700">
              <AlertCircle className="h-7 w-7" aria-hidden="true" />
            </div>
            <p className="text-base font-semibold text-foreground">
              {t('states.failed.title')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('states.failed.subtitle')}
            </p>
            <Button type="button" onClick={handleConnect} className="mt-2">
              {t('actions.retry')}
            </Button>
          </div>
        ) : isIdle ? (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-100 text-brand-700">
              <Smartphone className="h-7 w-7" aria-hidden="true" />
            </div>
            <p className="text-sm text-muted-foreground">{t('states.idle')}</p>
            <Button
              type="button"
              size="lg"
              onClick={handleConnect}
              className="min-h-11 gap-2"
            >
              <QrCode className="h-4 w-4" aria-hidden="true" />
              {t('actions.connect')}
            </Button>
          </div>
        ) : null}
      </div>

      {/* ¿Cómo funciona? (pratfall/honesty sobre WAHA no oficial) */}
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <button
          type="button"
          onClick={() => setShowHowItWorks((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('howItWorks.title')}
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 transition-transform',
              showHowItWorks && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
        {showHowItWorks ? (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {t('howItWorks.body')}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={() => router.push(`/${locale}/onboarding/4`)}
          className="min-h-11 gap-2"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {tShell('back')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => setConfirmSkipOpen(true)}
          disabled={skipping || isConnected}
          className="min-h-11"
        >
          {t('actions.later')}
        </Button>
      </div>

      <AlertDialog open={confirmSkipOpen} onOpenChange={setConfirmSkipOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmSkip.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmSkip.body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('confirmSkip.stay')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSkip}
              className="bg-slate-800 hover:bg-slate-900"
            >
              {t('confirmSkip.leave')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
