'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  Bot,
  Building2,
  Check,
  Coins,
  MessageCircle,
  MessageSquareText,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import {
  WhatsappConnectionClient,
  type WahaStatusResponse,
} from '../config/whatsapp/WhatsappConnectionClient';

/* ─────────────────────────── Types ─────────────────────────── */

export interface ClinicSettings {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  locale: string;
  /** ISO 4217 (3 letras uppercase) — moneda de cobro de la clínica. */
  currency: string;
  address: string | null;
  autoConfirm: boolean;
  reminderOffsetsH: number[];
  confirmThresholdH: number;
  botGreeting: string | null;
  botFallback: string | null;
  botHandoffMsg: string | null;
  botTone: string | null;
}

type TabKey = 'general' | 'reminders' | 'bot' | 'whatsapp';
const VALID_TABS: readonly TabKey[] = [
  'general',
  'reminders',
  'bot',
  'whatsapp',
];

interface Props {
  clinic: ClinicSettings;
  /** Estado inicial de la sesión WAHA — hidrata el tab WhatsApp sin flash. */
  wahaInitial: WahaStatusResponse;
  /** Token cookie leído server-side — necesario para el WhatsappConnectionClient. */
  token: string;
}

/**
 * Lista curada de timezones IANA — evitamos exponer las 500+ zonas que trae
 * Intl.supportedValuesOf. Cubre AR/BR/UY/CL/CO/MX/VE (mercados target del piloto).
 * Para casos edge (Europa, Asia), el operador puede editar el string directo
 * en el input — el backend valida con Intl.DateTimeFormat.
 */
/**
 * Los hints del bot (es/pt) contienen literalmente `{clinicName}` y
 * `{patientName}` como referencia visual al operador. next-intl los parsea
 * como variables ICU — hay que pasarles un valor. Le pasamos la misma
 * string entre llaves para que el render final sea idéntico al texto original.
 * Alternativa: `t.rich` con tags, pero es más código para un texto puramente
 * informativo (los placeholders reales viven en `PlaceholdersHint`).
 */
const PLACEHOLDER_LITERALS = {
  clinicName: '{clinicName}',
  patientName: '{patientName}',
} as const;

const COMMON_TIMEZONES = [
  'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo',
  'America/Bahia',
  'America/Fortaleza',
  'America/Manaus',
  'America/Montevideo',
  'America/Santiago',
  'America/Bogota',
  'America/Mexico_City',
  'America/Caracas',
  'America/Lima',
  'America/La_Paz',
] as const;

/**
 * Whitelist de monedas ISO 4217 aceptadas. Sincronizada 1:1 con
 * `ALLOWED_CURRENCIES` del backend (`apps/backend/src/clinics/dto/`).
 * Cubre LATAM completo + majors (USD, EUR). El nombre humano se resuelve
 * en render vía i18n `panel.settings.currencies.<CODE>` — así una app pt-BR
 * puede mostrar "Peso argentino" o "Peso argentino" según corresponda.
 */
const ALLOWED_CURRENCIES = [
  'ARS',
  'BOB',
  'BRL',
  'CLP',
  'COP',
  'CRC',
  'DOP',
  'EUR',
  'GTQ',
  'HNL',
  'MXN',
  'NIO',
  'PAB',
  'PEN',
  'PYG',
  'USD',
  'UYU',
  'VES',
] as const;

type CurrencyCode = (typeof ALLOWED_CURRENCIES)[number];

/* ═══════════════════════════════════════════════════════════════════
 *                         AJUSTES CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Layout: sidebar izq (~220px) con tabs verticales + card der con el form
 * activo. Cada tab tiene su propio submit independiente — cambiar el bot NO
 * obliga a validar el timezone.
 *
 * Fetch: hidratado con `initialData` desde el server component. Toda mutation
 * invalida `queryKeys.clinicMe` → refetch automático + refresca cualquier
 * consumidor de la clínica (agenda picker, etc.).
 */
export function AjustesClient({
  clinic: initialClinic,
  wahaInitial,
  token,
}: Props) {
  const t = useTranslations('panel.settings');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Tab activo desde URL (`?tab=...`) — permite deep-linking y que el redirect
  // desde /panel/config/whatsapp aterrice en el tab correcto. Default: general.
  const tab: TabKey = useMemo(() => {
    const raw = searchParams.get('tab');
    return (VALID_TABS as readonly string[]).includes(raw ?? '')
      ? (raw as TabKey)
      : 'general';
  }, [searchParams]);

  const setTab = useCallback(
    (next: TabKey) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', next);
      // replace en vez de push → no ensucia el history con cada click de tab.
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const { data: clinic = initialClinic } = useQuery({
    queryKey: queryKeys.clinicMe,
    queryFn: () => apiQuery<ClinicSettings>('/api/clinics/me'),
    initialData: initialClinic,
    staleTime: 30_000,
  });

  const tabs: Array<{ key: TabKey; label: string; icon: React.ElementType }> = [
    { key: 'general', label: t('tabs.general'), icon: Building2 },
    { key: 'reminders', label: t('tabs.reminders'), icon: Bell },
    { key: 'bot', label: t('tabs.bot'), icon: Bot },
    { key: 'whatsapp', label: t('tabs.whatsapp'), icon: MessageCircle },
  ];

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* ─────────  IZQUIERDA — SIDEBAR TABS  ───────── */}
      <aside className="hidden w-56 shrink-0 md:block">
        <nav className="space-y-0.5" aria-label={t('sidebarAriaLabel')}>
          {tabs.map((it) => {
            const Icon = it.icon;
            const active = it.key === tab;
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => setTab(it.key)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-brand-50 font-medium text-brand-800'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {it.label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Mobile: tabs horizontal scroll arriba del card */}
      <div className="md:hidden">
        <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
          {tabs.map((it) => {
            const Icon = it.icon;
            const active = it.key === tab;
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => setTab(it.key)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs',
                  active
                    ? 'bg-brand-50 font-medium text-brand-800'
                    : 'text-muted-foreground hover:bg-accent',
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {it.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─────────  DERECHA — FORM ACTIVO  ───────── */}
      <main className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-sm">
        {/* key remonta el form cuando cambia el tab: evita valores stale
            de otro tab si el user tabbeó sin guardar. En el tab WhatsApp
            el key también fuerza que el polling arranque desde cero al
            entrar (y se limpie al salir vía unmount). */}
        {tab === 'general' && (
          <GeneralForm key="general" clinic={clinic} />
        )}
        {tab === 'reminders' && (
          <RemindersForm key="reminders" clinic={clinic} />
        )}
        {tab === 'bot' && <BotForm key="bot" clinic={clinic} />}
        {tab === 'whatsapp' && (
          <WhatsappTab key="whatsapp" initial={wahaInitial} token={token} />
        )}
      </main>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                          FORM: GENERAL
 * ═══════════════════════════════════════════════════════════════════ */

const generalSchema = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().max(300).optional(),
  timezone: z.string().min(1),
  locale: z.enum(['es', 'pt']),
  currency: z.enum(ALLOWED_CURRENCIES),
  autoConfirm: z.boolean(),
});

type GeneralValues = z.infer<typeof generalSchema>;

function GeneralForm({ clinic }: { clinic: ClinicSettings }) {
  const t = useTranslations('panel.settings');
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<GeneralValues>({
    resolver: zodResolver(generalSchema),
    defaultValues: {
      name: clinic.name,
      address: clinic.address ?? '',
      timezone: clinic.timezone,
      locale: (clinic.locale as 'es' | 'pt') ?? 'es',
      // Si el backend responde una moneda fuera del whitelist (edge case por
      // manipulación directa en DB), caemos a USD para que Zod no rompa el
      // form entero — el operador puede corregirlo al guardar.
      currency: (ALLOWED_CURRENCIES as readonly string[]).includes(
        clinic.currency,
      )
        ? (clinic.currency as CurrencyCode)
        : 'USD',
      autoConfirm: clinic.autoConfirm,
    },
  });

  const tzValue = watch('timezone');
  const localeValue = watch('locale');
  const currencyValue = watch('currency');
  const autoConfirmValue = watch('autoConfirm');
  const tzChanged = tzValue !== clinic.timezone;

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiMutation<ClinicSettings, Record<string, unknown>>(
        '/api/clinics/me',
        'PATCH',
        payload,
      ),
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: queryKeys.clinicMe });
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: GeneralValues) {
    await mutation
      .mutateAsync({
        name: values.name,
        address: values.address || undefined,
        timezone: values.timezone,
        locale: values.locale,
        currency: values.currency,
        autoConfirm: values.autoConfirm,
      })
      .catch(() => undefined);
  }

  const busy = mutation.isPending;
  const useCustomTz = !COMMON_TIMEZONES.includes(
    tzValue as (typeof COMMON_TIMEZONES)[number],
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <FormHeader
        title={t('general.title')}
        description={t('general.description')}
        icon={<Building2 className="h-4 w-4" aria-hidden="true" />}
      />

      <Field
        label={t('fields.name')}
        htmlFor="gen-name"
        error={errors.name && t('errors.required')}
      >
        <Input id="gen-name" {...register('name')} disabled={busy} />
      </Field>

      <Field
        label={t('fields.address')}
        htmlFor="gen-address"
        hint={t('hints.address')}
      >
        <Textarea
          id="gen-address"
          {...register('address')}
          disabled={busy}
          rows={2}
          maxLength={300}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('fields.timezone')}
          htmlFor="gen-tz"
          hint={t('hints.timezone')}
        >
          <Select
            value={
              useCustomTz
                ? '__custom'
                : (tzValue as (typeof COMMON_TIMEZONES)[number])
            }
            onValueChange={(v) => {
              if (v === '__custom') return; // el input abajo maneja
              setValue('timezone', v, { shouldDirty: true });
            }}
            disabled={busy}
          >
            <SelectTrigger id="gen-tz">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMMON_TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
              <SelectItem value="__custom">
                {t('timezoneCustom')}
              </SelectItem>
            </SelectContent>
          </Select>
          {useCustomTz ? (
            <Input
              className="mt-2 tabular-nums"
              placeholder="Continent/City"
              {...register('timezone')}
              disabled={busy}
            />
          ) : null}
          {tzChanged ? (
            <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>{t('warnings.timezoneChange')}</span>
            </div>
          ) : null}
        </Field>

        <Field label={t('fields.locale')} htmlFor="gen-locale">
          <Select
            value={localeValue}
            onValueChange={(v) =>
              setValue('locale', v as 'es' | 'pt', { shouldDirty: true })
            }
            disabled={busy}
          >
            <SelectTrigger id="gen-locale">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="es">Español</SelectItem>
              <SelectItem value="pt">Português</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field
        label={t('fields.currency')}
        htmlFor="gen-currency"
        hint={t('hints.currency')}
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Select
            value={currencyValue}
            onValueChange={(v) =>
              setValue('currency', v as CurrencyCode, { shouldDirty: true })
            }
            disabled={busy}
          >
            <SelectTrigger id="gen-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {ALLOWED_CURRENCIES.map((code) => (
                <SelectItem key={code} value={code}>
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
                      {code}
                    </span>
                    <span>{t(`currencies.${code}`)}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <CurrencyPreview
            code={currencyValue}
            locale={localeValue}
          />
        </div>
      </Field>

      <ToggleField
        checked={autoConfirmValue}
        onChange={(v) =>
          setValue('autoConfirm', v, { shouldDirty: true })
        }
        disabled={busy}
        label={t('fields.autoConfirm')}
        description={t('hints.autoConfirm')}
      />

      <FormFooter busy={busy} isDirty={isDirty} />
    </form>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                        FORM: RECORDATORIOS
 * ═══════════════════════════════════════════════════════════════════ */

const remindersSchema = z.object({
  reminderOffsetsH: z
    .array(z.number().int().min(1).max(168))
    .max(5, 'máx 5 recordatorios'),
  confirmThresholdH: z.coerce.number().int().min(1).max(72),
});

type RemindersValues = z.infer<typeof remindersSchema>;

function RemindersForm({ clinic }: { clinic: ClinicSettings }) {
  const t = useTranslations('panel.settings');
  const qc = useQueryClient();

  const {
    handleSubmit,
    register,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<RemindersValues>({
    resolver: zodResolver(remindersSchema),
    defaultValues: {
      reminderOffsetsH: [...clinic.reminderOffsetsH].sort((a, b) => b - a),
      confirmThresholdH: clinic.confirmThresholdH,
    },
  });

  const offsets = watch('reminderOffsetsH');
  const [draftOffset, setDraftOffset] = useState('');

  function addOffset() {
    const n = Number(draftOffset);
    if (!Number.isFinite(n) || n < 1 || n > 168) {
      toast.error(t('errors.offsetRange'));
      return;
    }
    if (offsets.includes(n)) {
      toast.error(t('errors.offsetDuplicate'));
      return;
    }
    if (offsets.length >= 5) {
      toast.error(t('errors.offsetMax'));
      return;
    }
    setValue('reminderOffsetsH', [...offsets, n].sort((a, b) => b - a), {
      shouldDirty: true,
    });
    setDraftOffset('');
  }

  function removeOffset(h: number) {
    setValue(
      'reminderOffsetsH',
      offsets.filter((v) => v !== h),
      { shouldDirty: true },
    );
  }

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiMutation<ClinicSettings, Record<string, unknown>>(
        '/api/clinics/me',
        'PATCH',
        payload,
      ),
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: queryKeys.clinicMe });
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: RemindersValues) {
    await mutation
      .mutateAsync({
        reminderOffsetsH: values.reminderOffsetsH,
        confirmThresholdH: values.confirmThresholdH,
      })
      .catch(() => undefined);
  }

  const busy = mutation.isPending;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <FormHeader
        title={t('reminders.title')}
        description={t('reminders.description')}
        icon={<Bell className="h-4 w-4" aria-hidden="true" />}
      />

      <Field
        label={t('fields.offsets')}
        hint={t('hints.offsets')}
        error={
          errors.reminderOffsetsH ? t('errors.offsetMax') : undefined
        }
      >
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {offsets.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">
                {t('offsetsEmpty')}
              </p>
            ) : (
              offsets.map((h) => (
                <span
                  key={h}
                  className="inline-flex items-center gap-1 rounded-full border border-brand-300 bg-brand-50 py-0.5 pl-2 pr-0.5 text-xs font-medium tabular-nums text-brand-800"
                >
                  {t('offsetChip', { h })}
                  <button
                    type="button"
                    onClick={() => removeOffset(h)}
                    disabled={busy}
                    aria-label={t('removeOffset', { h })}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-brand-700 hover:bg-brand-100"
                  >
                    <X className="h-2.5 w-2.5" aria-hidden="true" />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={168}
              placeholder="24"
              value={draftOffset}
              onChange={(e) => setDraftOffset(e.target.value)}
              disabled={busy || offsets.length >= 5}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addOffset();
                }
              }}
              className="max-w-24 tabular-nums"
            />
            <span className="text-xs text-muted-foreground">
              {t('hoursSuffix')}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addOffset}
              disabled={busy || !draftOffset || offsets.length >= 5}
              className="gap-1"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('addOffset')}
            </Button>
          </div>
        </div>
      </Field>

      <Field
        label={t('fields.threshold')}
        htmlFor="rem-threshold"
        hint={t('hints.threshold')}
        error={errors.confirmThresholdH && t('errors.thresholdRange')}
      >
        <div className="flex items-center gap-2">
          <Input
            id="rem-threshold"
            type="number"
            min={1}
            max={72}
            {...register('confirmThresholdH')}
            disabled={busy}
            className="max-w-24 tabular-nums"
          />
          <span className="text-xs text-muted-foreground">
            {t('hoursSuffix')}
          </span>
        </div>
      </Field>

      <FormFooter busy={busy} isDirty={isDirty} />
    </form>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                           FORM: BOT
 * ═══════════════════════════════════════════════════════════════════ */

const botSchema = z.object({
  botGreeting: z.string().max(500).optional(),
  botFallback: z.string().max(500).optional(),
  botHandoffMsg: z.string().max(500).optional(),
  botTone: z.enum(['formal', 'cercano', 'tecnico']).optional(),
});

type BotValues = z.infer<typeof botSchema>;

function BotForm({ clinic }: { clinic: ClinicSettings }) {
  const t = useTranslations('panel.settings');
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<BotValues>({
    resolver: zodResolver(botSchema),
    defaultValues: {
      botGreeting: clinic.botGreeting ?? '',
      botFallback: clinic.botFallback ?? '',
      botHandoffMsg: clinic.botHandoffMsg ?? '',
      botTone:
        (clinic.botTone as 'formal' | 'cercano' | 'tecnico' | null) ??
        undefined,
    },
  });

  const tone = watch('botTone');

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiMutation<ClinicSettings, Record<string, unknown>>(
        '/api/clinics/me',
        'PATCH',
        payload,
      ),
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: queryKeys.clinicMe });
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: BotValues) {
    await mutation
      .mutateAsync({
        botGreeting: values.botGreeting || '',
        botFallback: values.botFallback || '',
        botHandoffMsg: values.botHandoffMsg || '',
        botTone: values.botTone || '',
      })
      .catch(() => undefined);
  }

  const busy = mutation.isPending;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <FormHeader
        title={t('bot.title')}
        description={t('bot.description')}
        icon={<Bot className="h-4 w-4" aria-hidden="true" />}
      />

      <PlaceholdersHint />

      <Field
        label={t('fields.tone')}
        htmlFor="bot-tone"
        hint={t('hints.tone')}
      >
        <Select
          value={tone ?? '__default'}
          onValueChange={(v) =>
            setValue(
              'botTone',
              v === '__default'
                ? undefined
                : (v as 'formal' | 'cercano' | 'tecnico'),
              { shouldDirty: true },
            )
          }
          disabled={busy}
        >
          <SelectTrigger id="bot-tone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default">{t('toneDefault')}</SelectItem>
            <SelectItem value="cercano">{t('toneCercano')}</SelectItem>
            <SelectItem value="formal">{t('toneFormal')}</SelectItem>
            <SelectItem value="tecnico">{t('toneTecnico')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <BotMessageField
        htmlFor="bot-greeting"
        label={t('fields.botGreeting')}
        hint={t('hints.botGreeting', PLACEHOLDER_LITERALS)}
        register={register('botGreeting')}
        disabled={busy}
        placeholder="¡Hola! Soy el asistente de {clinicName}…"
        error={errors.botGreeting?.message}
      />

      <BotMessageField
        htmlFor="bot-fallback"
        label={t('fields.botFallback')}
        hint={t('hints.botFallback', PLACEHOLDER_LITERALS)}
        register={register('botFallback')}
        disabled={busy}
        placeholder="Puedo ayudarte con agendar, reagendar o cancelar…"
        error={errors.botFallback?.message}
      />

      <BotMessageField
        htmlFor="bot-handoff"
        label={t('fields.botHandoffMsg')}
        hint={t('hints.botHandoffMsg', PLACEHOLDER_LITERALS)}
        register={register('botHandoffMsg')}
        disabled={busy}
        placeholder="Enseguida te atiende una persona del equipo. 🙏"
        error={errors.botHandoffMsg?.message}
      />

      <FormFooter busy={busy} isDirty={isDirty} />
    </form>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                         TAB: WHATSAPP
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Wrapper visual del `WhatsappConnectionClient` existente para consistencia
 * con los otros tabs (mismo `FormHeader`). El client component se importa
 * SIN modificar — mantiene su lógica de polling, QR, mutations, etc.
 */
function WhatsappTab({
  initial,
  token,
}: {
  initial: WahaStatusResponse;
  token: string;
}) {
  const t = useTranslations('panel.settings');
  return (
    <div className="space-y-5">
      <FormHeader
        title={t('whatsapp.title')}
        description={t('whatsapp.description')}
        icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}
      />
      <WhatsappConnectionClient initial={initial} token={token} />
    </div>
  );
}

/* ─────────────────────────── UI helpers ─────────────────────────── */

function FormHeader({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="space-y-1 border-b border-border/60 pb-4">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function ToggleField({
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500"
      />
      <span className="flex-1">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

function BotMessageField({
  htmlFor,
  label,
  hint,
  register,
  disabled,
  placeholder,
  error,
}: {
  htmlFor: string;
  label: string;
  hint: string;
  register: ReturnType<ReturnType<typeof useForm<BotValues>>['register']>;
  disabled: boolean;
  placeholder: string;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="flex items-center gap-1.5">
        <MessageSquareText
          className="h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        {label}
      </Label>
      <Textarea
        id={htmlFor}
        rows={2}
        maxLength={500}
        placeholder={placeholder}
        {...register}
        disabled={disabled}
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function PlaceholdersHint() {
  const t = useTranslations('panel.settings');
  return (
    <div className="rounded-md border border-brand-200 bg-brand-50/50 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-brand-700">
        {t('placeholdersTitle')}
      </p>
      <p className="mt-1 text-xs text-brand-900/80">
        {t.rich('placeholdersBody', {
          clinicName: () => (
            <code className="rounded bg-brand-100 px-1 py-0.5 font-mono text-[11px]">
              {'{clinicName}'}
            </code>
          ),
          patientName: () => (
            <code className="rounded bg-brand-100 px-1 py-0.5 font-mono text-[11px]">
              {'{patientName}'}
            </code>
          ),
        })}
      </p>
    </div>
  );
}

/**
 * Preview visual del formato de moneda seleccionado. Le da al operador
 * feedback inmediato de cómo se va a ver un precio (ej. "US$ 1.500" vs.
 * "Bs. 1.500,00") sin tener que ir al dashboard a chequearlo.
 *
 * Usa `Intl.NumberFormat` — el mismo motor que renderiza los montos reales
 * en TopServicesBar y KpiCard, así que lo que se ve acá es EXACTAMENTE lo
 * que va a verse en la operación. Fallback silencioso si el runtime no
 * soporta la moneda (raro pero posible en Node viejo).
 */
function CurrencyPreview({ code, locale }: { code: string; locale: string }) {
  const t = useTranslations('panel.settings');
  let formatted = '—';
  try {
    formatted = new Intl.NumberFormat(locale === 'pt' ? 'pt-BR' : 'es', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).format(1500);
  } catch {
    formatted = `${code} 1.500`;
  }
  return (
    <div
      className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
      aria-label={t('currencyPreviewAria', { formatted })}
    >
      <Coins className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {t('currencyPreviewLabel')}
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {formatted}
      </span>
    </div>
  );
}

function FormFooter({ busy, isDirty }: { busy: boolean; isDirty: boolean }) {
  const t = useTranslations('panel.settings');
  return (
    <footer className="flex items-center justify-end gap-2 border-t border-border/60 pt-4">
      <Button
        type="submit"
        size="sm"
        disabled={busy || !isDirty}
        className="min-w-[120px] gap-1.5"
      >
        {busy ? (
          <>
            <Sparkles
              className="h-3.5 w-3.5 animate-pulse"
              aria-hidden="true"
            />
            {t('saving')}
          </>
        ) : (
          <>
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {t('save')}
          </>
        )}
      </Button>
    </footer>
  );
}
