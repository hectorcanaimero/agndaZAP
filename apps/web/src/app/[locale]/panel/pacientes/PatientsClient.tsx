'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase,
  Calendar,
  Check,
  ExternalLink,
  MessageSquare,
  Phone,
  Search,
  ShieldCheck,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge, type AppointmentStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  MasterDetailShell,
  useMobileSheet,
} from '@/components/panel/master-detail';
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

/* ─────────────────────────── Types ─────────────────────────── */

interface PatientRow {
  id: string;
  phone: string;
  name: string | null;
  consent: boolean;
  createdAt: string;
  appointmentCount: number;
}

export interface PatientListResponse {
  rows: PatientRow[];
  total: number;
}

interface PatientDetail extends PatientRow {
  conversationCount: number;
}

interface HistoryAppointment {
  id: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  service: { id: string; name: string; durationMin: number };
  professional: { id: string; name: string };
}

interface HistoryConversation {
  id: string;
  state: 'BOT' | 'NEEDS_HUMAN' | 'HUMAN';
  updatedAt: string;
  contactName: string | null;
  lastMessage: {
    body: string;
    direction: 'IN' | 'OUT';
    createdAt: string;
  } | null;
}

interface PatientHistory {
  appointments: HistoryAppointment[];
  conversation: HistoryConversation | null;
}

type PanelMode = { kind: 'empty' } | { kind: 'edit'; patient: PatientRow };

interface Props {
  locale: string;
  initial: PatientListResponse;
}

/* ─────────────────────────── Helpers ─────────────────────────── */

function getInitials(name: string | null, phone: string): string {
  if (name?.trim()) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  }
  // Fallback a las 2 últimas cifras del phone.
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-2) || '··';
}

function formatPhone(raw: string): string {
  const d = raw.replace(/[^0-9]/g, '');
  if (d.length < 8) return raw;
  if (d.startsWith('549') && d.length >= 12) {
    const rest = d.slice(3);
    return `+54 9 ${rest.slice(0, 2)} ${rest.slice(2, 6)} ${rest.slice(6)}`;
  }
  if (d.startsWith('55') && d.length >= 12) {
    const rest = d.slice(2);
    return `+55 ${rest.slice(0, 2)} ${rest.slice(2, 7)}-${rest.slice(7)}`;
  }
  return `+${d}`;
}

/* ═══════════════════════════════════════════════════════════════════
 *                         PATIENTS CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

export function PatientsClient({ locale, initial }: Props) {
  const t = useTranslations('panel.patients');
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<PanelMode>({ kind: 'empty' });
  const mobileSheet = useMobileSheet();

  /*
   * Búsqueda server-side (a diferencia de los otros master-detail que
   * filtran client-side). Motivo: los pacientes pueden ser cientos-miles;
   * cargar todos y filtrar en memoria escala mal. El `q` va en la query
   * key para cachear por búsqueda.
   */
  const { data } = useQuery({
    queryKey: queryKeys.patients(search.trim() || undefined),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('q', search.trim());
      qs.set('limit', '50');
      return apiQuery<PatientListResponse>(`/api/patients?${qs.toString()}`);
    },
    initialData: search.trim() === '' ? initial : undefined,
    staleTime: 30_000,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  const activeId = panel.kind === 'edit' ? panel.patient.id : null;

  function openEdit(p: PatientRow) {
    setPanel({ kind: 'edit', patient: p });
    mobileSheet.openIfMobile();
  }

  function closePanel() {
    setPanel({ kind: 'empty' });
    mobileSheet.close();
  }

  const sidebar = (
    <>
      <div className="shrink-0 space-y-2 border-b border-border/60 p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-9 pl-8"
            aria-label={t('searchPlaceholder')}
          />
        </div>
        <p className="px-0.5 text-[11px] tabular-nums text-muted-foreground">
          {search.trim()
            ? t('countMatch', { n: rows.length })
            : t('countLabel', { n: total })}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-sm text-muted-foreground">
            {search.trim() ? t('noSearchResults') : t('emptyList')}
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1">
          {rows.map((p) => (
            <li key={p.id}>
              <PatientRow
                patient={p}
                active={p.id === activeId}
                onSelect={() => openEdit(p)}
                t={t}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const panelContent =
    panel.kind === 'empty' ? (
      <EmptyPanel />
    ) : (
      <PatientDetailPanel
        key={panel.patient.id}
        patient={panel.patient}
        locale={locale}
        onClose={closePanel}
        onSaved={(updated) => {
          setPanel({ kind: 'edit', patient: updated });
          void qc.invalidateQueries({ queryKey: ['patients'] });
        }}
      />
    );

  return (
    <MasterDetailShell
      sidebar={sidebar}
      panel={panelContent}
      mobile={mobileSheet}
      mobileTitle={
        panel.kind === 'edit' ? panel.patient.name ?? panel.patient.phone : ''
      }
      hidePanelInSheet={panel.kind === 'empty'}
      mobileSheetMaxWidth="sm:max-w-lg"
    />
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            PATIENT ROW
 * ═══════════════════════════════════════════════════════════════════ */

function PatientRow({
  patient: p,
  active,
  onSelect,
  t,
}: {
  patient: PatientRow;
  active: boolean;
  onSelect: () => void;
  t: ReturnType<typeof useTranslations<'panel.patients'>>;
}) {
  const initials = getInitials(p.name, p.phone);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-brand-50 text-foreground'
          : 'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-2.5 h-10 w-0.5 rounded-r-full bg-brand-600"
        />
      ) : null}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {p.name?.trim() || t('unnamed')}
        </p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] tabular-nums text-muted-foreground">
          <Phone className="h-3 w-3" aria-hidden="true" />
          {formatPhone(p.phone)}
        </p>
        <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Calendar className="h-3 w-3" aria-hidden="true" />
          {t('appointmentCount', { n: p.appointmentCount })}
          {p.consent ? (
            <>
              <span aria-hidden="true">·</span>
              <ShieldCheck
                className="h-3 w-3 text-emerald-600"
                aria-hidden="true"
              />
              <span className="text-emerald-700">{t('consentShort')}</span>
            </>
          ) : null}
        </p>
      </div>
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            EMPTY PANEL
 * ═══════════════════════════════════════════════════════════════════ */

function EmptyPanel() {
  const t = useTranslations('panel.patients');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="relative">
        <svg
          width="120"
          height="120"
          viewBox="0 0 120 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="text-brand-600/80"
        >
          <circle cx="60" cy="60" r="52" className="fill-brand-50" />
          {/* Cabeza + torso silueta */}
          <circle
            cx="60"
            cy="46"
            r="10"
            stroke="currentColor"
            strokeWidth="1.5"
            className="opacity-60"
          />
          <path
            d="M40 84 Q40 66, 60 66 Q80 66, 80 84"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            className="opacity-60"
          />
          {/* Historial: 3 líneas al costado */}
          <line
            x1="86"
            y1="46"
            x2="98"
            y2="46"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="opacity-40"
          />
          <line
            x1="86"
            y1="52"
            x2="94"
            y2="52"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="opacity-40"
          />
          <line
            x1="86"
            y1="58"
            x2="96"
            y2="58"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="opacity-40"
          />
          {/* Sparkle */}
          <path
            d="M26 34l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
            className="fill-amber-400"
          />
        </svg>
      </div>
      <div className="max-w-xs space-y-1.5">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {t('empty.title')}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t('empty.description')}
        </p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                       PATIENT DETAIL PANEL
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Panel derecho con 3 secciones apiladas:
 *   1. Header — avatar + nombre + acciones
 *   2. Identidad editable — name + consent (ratchet)
 *   3. Historial — timeline citas + link a conversación
 */
function PatientDetailPanel({
  patient,
  locale,
  onClose,
  onSaved,
}: {
  patient: PatientRow;
  locale: string;
  onClose: () => void;
  onSaved: (updated: PatientRow) => void;
}) {
  const t = useTranslations('panel.patients');
  const qc = useQueryClient();

  // Detail refresca al abrir para tener contadores actualizados; usamos el
  // `patient` del list como fallback en el interin.
  const detailQuery = useQuery({
    queryKey: queryKeys.patient(patient.id),
    queryFn: () => apiQuery<PatientDetail>(`/api/patients/${patient.id}`),
    initialData: {
      ...patient,
      conversationCount: 0,
    } satisfies PatientDetail,
    staleTime: 30_000,
  });

  const historyQuery = useQuery({
    queryKey: queryKeys.patientHistory(patient.id),
    queryFn: () =>
      apiQuery<PatientHistory>(`/api/patients/${patient.id}/history`),
    staleTime: 30_000,
  });

  const detail = detailQuery.data ?? patient;

  // Form controlado local — cuando cambia el patient (por remount con key),
  // el estado arranca desde cero. Sin useForm porque son solo 2 campos.
  const [name, setName] = useState(patient.name ?? '');
  const [consent, setConsent] = useState(patient.consent);

  const isDirty =
    name.trim() !== (patient.name ?? '') || consent !== patient.consent;

  const saveMutation = useMutation({
    mutationFn: (body: { name?: string; consent?: boolean }) =>
      apiMutation<PatientDetail, typeof body>(
        `/api/patients/${patient.id}`,
        'PATCH',
        body,
      ),
    onSuccess: (updated) => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['patients'] });
      void qc.invalidateQueries({ queryKey: queryKeys.patient(patient.id) });
      onSaved({
        id: updated.id,
        phone: updated.phone,
        name: updated.name,
        consent: updated.consent,
        createdAt:
          typeof updated.createdAt === 'string'
            ? updated.createdAt
            : new Date(updated.createdAt).toISOString(),
        appointmentCount: updated.appointmentCount,
      });
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  const busy = saveMutation.isPending;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !isDirty) return;
    const payload: { name?: string; consent?: boolean } = {};
    if (name.trim() !== (patient.name ?? '')) payload.name = name.trim();
    if (consent !== patient.consent) payload.consent = consent;
    saveMutation.mutate(payload);
  }

  const initials = getInitials(patient.name, patient.phone);
  const waPhone = patient.phone.replace(/[^0-9]/g, '');

  return (
    <form
      onSubmit={onSubmit}
      className="flex h-full min-h-0 flex-col"
      noValidate
    >
      {/* Header sticky */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white"
            aria-hidden="true"
          >
            {initials}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('detailLabel')}
            </p>
            <h2 className="truncate text-base font-semibold text-foreground">
              {patient.name?.trim() || t('unnamed')}
            </h2>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          aria-label={t('close')}
          disabled={busy}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </header>

      {/* Body scrollable */}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        {/* ─── Sección: Identidad ─── */}
        <section className="space-y-3">
          <SectionHeader
            icon={<User className="h-4 w-4" aria-hidden="true" />}
            title={t('sections.identity')}
          />
          <div className="space-y-1.5">
            <Label htmlFor="pat-name">{t('fields.name')}</Label>
            <Input
              id="pat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={80}
              placeholder={t('placeholders.name')}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Phone
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              {t('fields.phone')}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                value={formatPhone(patient.phone)}
                readOnly
                className="flex-1 tabular-nums"
              />
              <Button
                asChild
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
              >
                <a
                  href={`https://wa.me/${waPhone}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('openInWhatsApp')}
                  <ExternalLink className="h-3 w-3 opacity-60" aria-hidden="true" />
                </a>
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('hints.phone')}
            </p>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              disabled={busy || patient.consent}
              className="mt-0.5 h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500"
            />
            <span className="flex-1">
              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <ShieldCheck
                  className={cn(
                    'h-3.5 w-3.5',
                    consent ? 'text-emerald-600' : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
                {t('fields.consent')}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {patient.consent
                  ? t('hints.consentGranted')
                  : t('hints.consent')}
              </span>
            </span>
          </label>
        </section>

        {/* ─── Sección: Historial de citas ─── */}
        <section className="space-y-3">
          <SectionHeader
            icon={<Calendar className="h-4 w-4" aria-hidden="true" />}
            title={t('sections.appointments')}
            extra={
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t('appointmentCount', { n: detail.appointmentCount })}
              </span>
            }
          />
          {historyQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">{t('loading')}</p>
          ) : historyQuery.data?.appointments.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
              {t('noAppointments')}
            </p>
          ) : (
            <ul className="space-y-1">
              {historyQuery.data?.appointments.slice(0, 10).map((appt) => (
                <li key={appt.id}>
                  <AppointmentHistoryItem appt={appt} locale={locale} />
                </li>
              ))}
              {(historyQuery.data?.appointments.length ?? 0) > 10 ? (
                <li className="pt-1 text-center text-[11px] text-muted-foreground">
                  {t('moreAppointments', {
                    n: (historyQuery.data?.appointments.length ?? 0) - 10,
                  })}
                </li>
              ) : null}
            </ul>
          )}
        </section>

        {/* ─── Sección: Conversación ─── */}
        <section className="space-y-3">
          <SectionHeader
            icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
            title={t('sections.conversation')}
          />
          {historyQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">{t('loading')}</p>
          ) : historyQuery.data?.conversation ? (
            <Link
              href={`/${locale}/panel/conversaciones?open=${historyQuery.data.conversation.id}`}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-background p-3 transition-colors hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {historyQuery.data.conversation.lastMessage?.body ??
                    t('noMessages')}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t(`convState.${historyQuery.data.conversation.state}`)}
                </p>
              </div>
              <ExternalLink
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          ) : (
            <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
              {t('noConversation')}
            </p>
          )}
        </section>
      </div>

      {/* Footer sticky */}
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          disabled={busy}
        >
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={busy || !isDirty}
          className="min-w-[100px] gap-1.5"
        >
          {busy ? (
            <>
              <Sparkles className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
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
    </form>
  );
}

/* ─────────────────────────── UI helpers ─────────────────────────── */

function SectionHeader({
  icon,
  title,
  extra,
}: {
  icon: React.ReactNode;
  title: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>
        {title}
      </h3>
      {extra}
    </div>
  );
}

function AppointmentHistoryItem({
  appt,
  locale,
}: {
  appt: HistoryAppointment;
  locale: string;
}) {
  const tStatus = useTranslations('panel.dashboard.status');
  const start = new Date(appt.startAt);
  const dateFmt = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(start);
  const timeFmt = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(start);

  return (
    <div className="flex items-start gap-2.5 rounded-md border border-border bg-background p-2.5">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-md border border-border bg-muted/40 text-center">
        <span className="text-[9px] font-medium uppercase text-muted-foreground">
          {new Intl.DateTimeFormat(locale, { month: 'short' }).format(start)}
        </span>
        <span className="text-xs font-semibold tabular-nums leading-none text-foreground">
          {start.getDate()}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium text-foreground">
            {appt.service.name}
          </p>
          <Badge variant={appt.status} className="shrink-0 text-[10px]">
            {tStatus(appt.status)}
          </Badge>
        </div>
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {dateFmt} · {timeFmt}
          </span>
        </p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
          <Briefcase className="h-3 w-3" aria-hidden="true" />
          {appt.professional.name}
        </p>
      </div>
    </div>
  );
}
