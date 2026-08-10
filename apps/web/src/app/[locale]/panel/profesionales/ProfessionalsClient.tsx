'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Award,
  Briefcase,
  Calendar,
  Check,
  Copy,
  FileText,
  Image as ImageIcon,
  Mail,
  Palette,
  Phone,
  Plus,
  Search,
  Sparkles,
  Stethoscope,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

/* ─────────────────────────── Types ─────────────────────────── */

interface Professional {
  id: string;
  name: string;
  active: boolean;
  email: string | null;
  phone: string | null;
  specialty: string | null;
  bio: string | null;
  avatarUrl: string | null;
  licenseNumber: string | null;
  color: string | null;
  services: Array<{ id: string; name: string }>;
}

interface ServiceLite {
  id: string;
  name: string;
}

interface ProfessionalDetail extends Professional {
  icalUrl: string; // "/ical/professionals/:id?token=X"
}

interface Props {
  professionals: Professional[];
  services: ServiceLite[];
}

/**
 * Schema Zod alineado con `ProfessionalProfileFieldsDto` del backend + `name`
 * requerido. Strings vacíos se transforman a undefined para no romper las
 * validaciones optional (email, phone, url).
 */
const emptyToUndef = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const professionalSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.preprocess(emptyToUndef, z.string().email().max(200).optional()),
  phone: z.preprocess(
    emptyToUndef,
    z
      .string()
      .regex(/^\+?[1-9]\d{7,14}$/, 'phone debe ser E.164')
      .optional(),
  ),
  specialty: z.preprocess(emptyToUndef, z.string().max(120).optional()),
  bio: z.preprocess(emptyToUndef, z.string().max(1000).optional()),
  avatarUrl: z.preprocess(
    emptyToUndef,
    z.string().url().max(500).optional(),
  ),
  licenseNumber: z.preprocess(emptyToUndef, z.string().max(60).optional()),
  color: z.preprocess(
    emptyToUndef,
    z
      .string()
      .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'color debe ser hex')
      .optional(),
  ),
  serviceIds: z.array(z.string()).default([]),
});

type ProfessionalFormValues = z.infer<typeof professionalSchema>;

type PanelMode =
  | { kind: 'empty' }
  | { kind: 'create' }
  | { kind: 'edit'; professional: Professional };

/* ═══════════════════════════════════════════════════════════════════
 *                        PROFESSIONALS CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Master-detail 2-col (mismo patrón que servicios). Panel derecho con secciones:
 * Identidad, Perfil profesional, Servicios, Visual, y (solo edit) Calendar sync
 * con iCal feed URL copiable.
 */
export function ProfessionalsClient({
  professionals: initialProfessionals,
  services,
}: Props) {
  const t = useTranslations('panel.professionals');
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<PanelMode>({ kind: 'empty' });
  const [deleteTarget, setDeleteTarget] = useState<Professional | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const { data: professionals = initialProfessionals } = useQuery({
    queryKey: queryKeys.professionals,
    queryFn: () => apiQuery<Professional[]>('/api/professionals'),
    initialData: initialProfessionals,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return professionals;
    return professionals.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.specialty ?? '').toLowerCase().includes(q) ||
        (p.email ?? '').toLowerCase().includes(q),
    );
  }, [professionals, search]);

  const activeId = panel.kind === 'edit' ? panel.professional.id : null;

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/professionals/${id}`, 'DELETE'),
    onSuccess: (_data, deletedId) => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: queryKeys.professionals });
      if (panel.kind === 'edit' && panel.professional.id === deletedId) {
        setPanel({ kind: 'empty' });
        setMobileSheetOpen(false);
      }
    },
    onError: () => {
      toast.error(t('deleteFailed'));
    },
    onSettled: () => setDeleteTarget(null),
  });

  // Guard con matchMedia — abrir Sheet solo en mobile. Sin esto Radix
  // renderiza el overlay del portal aunque el content tenga md:hidden.
  function isMobileViewport(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767.98px)').matches;
  }

  function openCreate() {
    setPanel({ kind: 'create' });
    if (isMobileViewport()) setMobileSheetOpen(true);
  }

  function openEdit(p: Professional) {
    setPanel({ kind: 'edit', professional: p });
    if (isMobileViewport()) setMobileSheetOpen(true);
  }

  function closePanel() {
    setPanel({ kind: 'empty' });
    setMobileSheetOpen(false);
  }

  function handleFormSuccess(saved: Professional, wasCreate: boolean) {
    setPanel({ kind: 'edit', professional: saved });
    if (wasCreate) setMobileSheetOpen(false);
  }

  const panelContent =
    panel.kind === 'empty' ? (
      <EmptyPanel onCreate={openCreate} />
    ) : (
      <ProfessionalForm
        key={panel.kind === 'edit' ? panel.professional.id : 'new'}
        mode={panel}
        services={services}
        onClose={closePanel}
        onSuccess={handleFormSuccess}
        onDelete={(p) => setDeleteTarget(p)}
      />
    );

  return (
    <>
      <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* ─────────  IZQUIERDA — LISTA  ───────── */}
        <aside className="flex min-h-0 w-full flex-col border-r border-border/60 md:w-[380px] md:shrink-0">
          <div className="shrink-0 space-y-2 border-b border-border/60 p-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
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
              <Button
                size="sm"
                className="h-9 shrink-0 gap-1.5"
                onClick={openCreate}
                aria-label={t('new')}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t('new')}</span>
              </Button>
            </div>
            <p className="px-0.5 text-[11px] tabular-nums text-muted-foreground">
              {t('countLabel', { n: professionals.length })}
              {search && filtered.length !== professionals.length ? (
                <>
                  {' '}
                  ·{' '}
                  <span className="text-foreground">
                    {t('countMatch', { n: filtered.length })}
                  </span>
                </>
              ) : null}
            </p>
          </div>

          {filtered.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">
                  {search ? t('noSearchResults') : t('emptyList')}
                </p>
                {!search ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={openCreate}
                  >
                    <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {t('createFirst')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1">
              {filtered.map((p) => (
                <li key={p.id}>
                  <ProfessionalRow
                    professional={p}
                    active={p.id === activeId}
                    onSelect={() => openEdit(p)}
                    t={t}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* ─────────  DERECHA — PANEL (solo md+)  ───────── */}
        <section className="hidden min-h-0 flex-1 md:flex md:flex-col">
          {panelContent}
        </section>
      </div>

      {/* ─────────  MOBILE — SHEET DRAWER  ───────── */}
      <Sheet
        open={mobileSheetOpen}
        onOpenChange={(o) => {
          if (!o) closePanel();
        }}
      >
        <SheetContent
          side="right"
          className="w-full overflow-y-auto p-0 sm:max-w-md md:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>
              {panel.kind === 'create'
                ? t('newTitle')
                : panel.kind === 'edit'
                  ? t('editTitle')
                  : ''}
            </SheetTitle>
          </SheetHeader>
          {panel.kind !== 'empty' ? panelContent : null}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
        title={t('confirmDelete.title')}
        description={t.rich('confirmDelete.description', {
          name: () => (
            <strong className="font-semibold text-foreground">
              {deleteTarget?.name ?? ''}
            </strong>
          ),
        })}
        confirmLabel={t('delete')}
        variant="destructive"
      />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                         PROFESSIONAL ROW
 * ═══════════════════════════════════════════════════════════════════ */

function ProfessionalRow({
  professional: p,
  active,
  onSelect,
  t,
}: {
  professional: Professional;
  active: boolean;
  onSelect: () => void;
  t: ReturnType<typeof useTranslations<'panel.professionals'>>;
}) {
  const initials = getInitials(p.name);
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
      {/* Avatar: foto si hay avatarUrl; sino iniciales sobre color propio o brand. */}
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold text-white',
          !p.avatarUrl && !p.color && 'bg-brand-500',
        )}
        style={
          !p.avatarUrl && p.color
            ? { backgroundColor: p.color }
            : undefined
        }
      >
        {p.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.avatarUrl}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          initials
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {p.name}
        </p>
        {p.specialty ? (
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <Stethoscope className="h-3 w-3" aria-hidden="true" />
            {p.specialty}
          </p>
        ) : null}
        <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Briefcase className="h-3 w-3" aria-hidden="true" />
          {p.services.length === 0 ? (
            <span className="italic">{t('noServicesRow')}</span>
          ) : (
            <span className="tabular-nums">
              {t('servicesCount', { n: p.services.length })}
            </span>
          )}
        </p>
      </div>
    </button>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return '··';
}

/* ═══════════════════════════════════════════════════════════════════
 *                            EMPTY PANEL
 * ═══════════════════════════════════════════════════════════════════ */

function EmptyPanel({ onCreate }: { onCreate: () => void }) {
  const t = useTranslations('panel.professionals');
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
          {/* Silueta persona */}
          <circle
            cx="60"
            cy="48"
            r="12"
            stroke="currentColor"
            strokeWidth="1.5"
            className="opacity-60"
          />
          <path
            d="M36 88 Q36 68, 60 68 Q84 68, 84 88"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            className="opacity-60"
          />
          {/* Estetoscopio decorativo */}
          <path
            d="M92 42 Q92 52, 82 52"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            className="opacity-40"
          />
          <circle
            cx="92"
            cy="38"
            r="4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            className="opacity-40"
          />
          {/* Sparkle */}
          <path
            d="M28 34l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
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
      <Button onClick={onCreate} className="mt-2 gap-1.5">
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('empty.cta')}
      </Button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                          PROFESSIONAL FORM
 * ═══════════════════════════════════════════════════════════════════ */

function ProfessionalForm({
  mode,
  services,
  onClose,
  onSuccess,
  onDelete,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; professional: Professional };
  services: ServiceLite[];
  onClose: () => void;
  onSuccess: (saved: Professional, wasCreate: boolean) => void;
  onDelete: (p: Professional) => void;
}) {
  const t = useTranslations('panel.professionals');
  const qc = useQueryClient();
  const isEdit = mode.kind === 'edit';
  const prof = isEdit ? mode.professional : null;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<ProfessionalFormValues>({
    resolver: zodResolver(professionalSchema),
    defaultValues: {
      name: prof?.name ?? '',
      email: prof?.email ?? undefined,
      phone: prof?.phone ?? undefined,
      specialty: prof?.specialty ?? undefined,
      bio: prof?.bio ?? undefined,
      avatarUrl: prof?.avatarUrl ?? undefined,
      licenseNumber: prof?.licenseNumber ?? undefined,
      color: prof?.color ?? undefined,
      serviceIds: prof?.services?.map((s) => s.id) ?? [],
    },
  });

  useEffect(() => {
    reset({
      name: prof?.name ?? '',
      email: prof?.email ?? undefined,
      phone: prof?.phone ?? undefined,
      specialty: prof?.specialty ?? undefined,
      bio: prof?.bio ?? undefined,
      avatarUrl: prof?.avatarUrl ?? undefined,
      licenseNumber: prof?.licenseNumber ?? undefined,
      color: prof?.color ?? undefined,
      serviceIds: prof?.services?.map((s) => s.id) ?? [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prof?.id]);

  const selectedServices = watch('serviceIds') ?? [];
  const currentColor = watch('color');
  const currentAvatar = watch('avatarUrl');
  const currentName = watch('name');

  function toggleService(id: string) {
    if (selectedServices.includes(id)) {
      setValue(
        'serviceIds',
        selectedServices.filter((s) => s !== id),
        { shouldDirty: true },
      );
    } else {
      setValue('serviceIds', [...selectedServices, id], { shouldDirty: true });
    }
  }

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (!isEdit) {
        return apiMutation<Professional, Record<string, unknown>>(
          '/api/professionals',
          'POST',
          payload,
        );
      }
      return apiMutation<Professional, Record<string, unknown>>(
        `/api/professionals/${prof!.id}`,
        'PATCH',
        payload,
      );
    },
    onSuccess: (saved) => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: queryKeys.professionals });
      onSuccess(saved, !isEdit);
    },
    onError: (err) => {
      // 409: email duplicado en la misma clínica (unique constraint del schema).
      if (
        err instanceof Error &&
        'status' in err &&
        (err as { status: number }).status === 409
      ) {
        toast.error(t('emailTaken'));
        return;
      }
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: ProfessionalFormValues) {
    const payload: Record<string, unknown> = {
      name: values.name,
      serviceIds: values.serviceIds,
    };
    // Solo enviamos las keys definidas (patch parcial más limpio en la wire).
    (
      [
        'email',
        'phone',
        'specialty',
        'bio',
        'avatarUrl',
        'licenseNumber',
        'color',
      ] as const
    ).forEach((k) => {
      if (values[k] !== undefined) payload[k] = values[k];
    });
    await saveMutation.mutateAsync(payload).catch(() => undefined);
  }

  const busy = saveMutation.isPending;

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex h-full min-h-0 flex-col"
      noValidate
    >
      {/* Header sticky */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold text-white',
              !currentAvatar && !currentColor && 'bg-brand-500',
            )}
            style={
              !currentAvatar && currentColor
                ? { backgroundColor: currentColor }
                : undefined
            }
            aria-hidden="true"
          >
            {currentAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentAvatar}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              getInitials(currentName || (isEdit ? prof!.name : ''))
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {isEdit ? t('editTitle') : t('newTitle')}
            </p>
            <h2 className="truncate text-base font-semibold text-foreground">
              {isEdit ? prof!.name : t('newSubtitle')}
            </h2>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onDelete(prof!)}
              aria-label={t('delete')}
              disabled={busy}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
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
        </div>
      </header>

      {/* Body scrollable */}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        {/* ─── Sección: Identidad ─── */}
        <FormSection
          icon={<User className="h-4 w-4" aria-hidden="true" />}
          title={t('sections.identity')}
        >
          <div className="space-y-1.5">
            <Label htmlFor="prof-name">{t('fields.name')}</Label>
            <Input
              id="prof-name"
              {...register('name')}
              disabled={busy}
              placeholder={t('placeholders.name')}
            />
            {errors.name ? (
              <p className="text-xs text-destructive">
                {t('errors.required')}
              </p>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="prof-email" className="flex items-center gap-1.5">
                <Mail
                  className="h-3.5 w-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                {t('fields.email')}
              </Label>
              <Input
                id="prof-email"
                type="email"
                {...register('email')}
                disabled={busy}
                placeholder="dra@clinica.com"
              />
              {errors.email ? (
                <p className="text-xs text-destructive">
                  {t('errors.email')}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prof-phone" className="flex items-center gap-1.5">
                <Phone
                  className="h-3.5 w-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                {t('fields.phone')}
              </Label>
              <Input
                id="prof-phone"
                type="tel"
                inputMode="tel"
                {...register('phone')}
                disabled={busy}
                placeholder="+54 9 11 5555 5555"
              />
              {errors.phone ? (
                <p className="text-xs text-destructive">
                  {t('errors.phone')}
                </p>
              ) : null}
            </div>
          </div>
        </FormSection>

        {/* ─── Sección: Perfil profesional ─── */}
        <FormSection
          icon={<Stethoscope className="h-4 w-4" aria-hidden="true" />}
          title={t('sections.profile')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="prof-specialty">{t('fields.specialty')}</Label>
              <Input
                id="prof-specialty"
                {...register('specialty')}
                disabled={busy}
                placeholder={t('placeholders.specialty')}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="prof-license"
                className="flex items-center gap-1.5"
              >
                <Award
                  className="h-3.5 w-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                {t('fields.licenseNumber')}
              </Label>
              <Input
                id="prof-license"
                {...register('licenseNumber')}
                disabled={busy}
                placeholder={t('placeholders.licenseNumber')}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prof-bio" className="flex items-center gap-1.5">
              <FileText
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              {t('fields.bio')}{' '}
              <span className="text-xs text-muted-foreground">
                ({t('optional')})
              </span>
            </Label>
            <Textarea
              id="prof-bio"
              {...register('bio')}
              disabled={busy}
              rows={3}
              placeholder={t('placeholders.bio')}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('hints.bio')}
            </p>
          </div>
        </FormSection>

        {/* ─── Sección: Servicios ─── */}
        <FormSection
          icon={<Briefcase className="h-4 w-4" aria-hidden="true" />}
          title={t('sections.services')}
          extra={
            selectedServices.length > 0 ? (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t('selectedCount', { n: selectedServices.length })}
              </span>
            ) : null
          }
        >
          {services.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-3 text-center">
              <p className="text-xs text-muted-foreground">
                {t('noServices')}
              </p>
            </div>
          ) : (
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
              {services.map((s) => {
                const checked = selectedServices.includes(s.id);
                return (
                  <label
                    key={s.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                      checked
                        ? 'bg-brand-50 text-foreground'
                        : 'hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleService(s.id)}
                      disabled={busy}
                      className="h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500"
                    />
                    <span className="flex-1 truncate">{s.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </FormSection>

        {/* ─── Sección: Visual ─── */}
        <FormSection
          icon={<Palette className="h-4 w-4" aria-hidden="true" />}
          title={t('sections.visual')}
        >
          <div className="space-y-1.5">
            <Label
              htmlFor="prof-avatar"
              className="flex items-center gap-1.5"
            >
              <ImageIcon
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              {t('fields.avatarUrl')}
            </Label>
            <Input
              id="prof-avatar"
              type="url"
              {...register('avatarUrl')}
              disabled={busy}
              placeholder="https://..."
            />
            {errors.avatarUrl ? (
              <p className="text-xs text-destructive">
                {t('errors.avatarUrl')}
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {t('hints.avatarUrl')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prof-color">{t('fields.color')}</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={currentColor || '#3b82f6'}
                onChange={(e) =>
                  setValue('color', e.target.value, { shouldDirty: true })
                }
                disabled={busy}
                className="h-9 w-14 shrink-0 cursor-pointer rounded-md border border-border bg-background"
                aria-label={t('fields.color')}
              />
              <Input
                id="prof-color"
                {...register('color')}
                disabled={busy}
                placeholder="#3b82f6"
                className="flex-1 tabular-nums"
              />
              {currentColor ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setValue('color', undefined, { shouldDirty: true })
                  }
                  disabled={busy}
                  className="h-9 shrink-0"
                >
                  {t('clear')}
                </Button>
              ) : null}
            </div>
            {errors.color ? (
              <p className="text-xs text-destructive">
                {t('errors.color')}
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {t('hints.color')}
            </p>
          </div>
        </FormSection>

        {/* ─── Sección: Calendar sync (solo edit) ─── */}
        {isEdit ? (
          <FormSection
            icon={<Calendar className="h-4 w-4" aria-hidden="true" />}
            title={t('sections.calendar')}
          >
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t('calendarSync.description')}
            </p>
            <CalendarUrlCopy professionalId={prof!.id} />
          </FormSection>
        ) : null}
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
          disabled={busy || (isEdit && !isDirty)}
          className="min-w-[100px]"
        >
          {busy ? (
            <>
              <Sparkles
                className="mr-1.5 h-3.5 w-3.5 animate-pulse"
                aria-hidden="true"
              />
              {t('saving')}
            </>
          ) : (
            t('save')
          )}
        </Button>
      </footer>
    </form>
  );
}

/* ─────────────────────────── Helpers UI ─────────────────────────── */

function FormSection({
  icon,
  title,
  extra,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="text-muted-foreground/70">{icon}</span>
          {title}
        </h3>
        {extra}
      </div>
      <div className="space-y-3 rounded-lg border border-border/60 bg-background/50 p-3">
        {children}
      </div>
    </section>
  );
}

/**
 * Botón "Copiar URL" del iCal feed. Fetch on demand del detail (para tener el
 * token pre-firmado). Copia URL absoluta (window.location.origin + path).
 */
function CalendarUrlCopy({ professionalId }: { professionalId: string }) {
  const t = useTranslations('panel.professionals');
  const [copied, setCopied] = useState(false);

  const { data, isFetching } = useQuery({
    queryKey: ['professional-detail', professionalId],
    queryFn: () =>
      apiQuery<ProfessionalDetail>(`/api/professionals/${professionalId}`),
    staleTime: 60_000,
  });

  const absoluteUrl = data?.icalUrl
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}${data.icalUrl}`
    : '';

  async function handleCopy() {
    if (!absoluteUrl) return;
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      toast.success(t('calendarSync.copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('calendarSync.copyFailed'));
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={
            isFetching
              ? t('calendarSync.loading')
              : absoluteUrl || t('calendarSync.unavailable')
          }
          readOnly
          className="flex-1 truncate text-xs tabular-nums"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCopy}
          disabled={!absoluteUrl || isFetching}
          className="shrink-0 gap-1.5"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t('calendarSync.copiedShort')}
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {t('calendarSync.copy')}
            </>
          )}
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t('calendarSync.instructions')}
      </p>
    </div>
  );
}
