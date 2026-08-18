'use client';

/**
 * FaqClient — "Base de conocimiento" con layout master-detail alineado con
 * el patrón del resto del panel (servicios, profesionales, horarios, bloqueos).
 *
 * Lo que se preserva de la versión previa (features críticas):
 * - `MarkdownEditor` component para escribir el content del artículo.
 * - Banner amarillo persistente cuando hay FAQs sin embedding (bug fix P0 —
 *   ver `docs/ux/2026-08-09-faq-embedding-banner.md`).
 * - Badges "Indexada" / "Sin indexar" por row con AA color contrast.
 * - Schema Zod con validaciones estrictas (title max 200, content 5-4000).
 * - Mutations: create (POST), edit (PATCH), delete (DELETE) con toasts.
 * - Vector `embedding` NUNCA viaja al cliente — el flag `hasEmbedding` se
 *   deriva server-side.
 *
 * Nuevo en este rewrite:
 * - Layout full-height card con lista izq (~380px) + panel der.
 * - Búsqueda cliente-side por title + content strippeado.
 * - Filtro toggle "Solo sin indexar" (útil para batch fixing tras subir
 *   OPENAI_API_KEY).
 * - Row activo con marker vertical brand (mismo lenguaje que conversaciones).
 * - Empty state con SVG específico (libro + sparkle).
 * - Mobile: Sheet drawer con guard matchMedia (evita backdrop en desktop).
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  FileText,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MarkdownEditor } from '@/components/ui/markdown-editor';
import {
  MasterDetailShell,
  useMobileSheet,
} from '@/components/panel/master-detail';
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type { FaqChunk } from './page';

const TITLE_MAX = 200;
const CONTENT_MIN = 5;
const CONTENT_MAX = 4000;

/** Schema Zod. Igual al anterior — se mantiene la validación cliente. */
const articleSchema = z.object({
  title: z
    .string()
    .max(TITLE_MAX)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  content: z.string().min(CONTENT_MIN).max(CONTENT_MAX),
});

type ArticleFormValues = z.infer<typeof articleSchema>;

interface Props {
  locale: string;
  rows: FaqChunk[];
  pendingCount: number;
}

type PanelMode =
  | { kind: 'empty' }
  | { kind: 'create' }
  | { kind: 'edit'; row: FaqChunk };

/* ─────────────────────────── Markdown helpers ─────────────────────────── */

/** Strippea markdown para preview limpio en la lista. Igual a la versión previa. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s+/gm, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

function labelFor(row: FaqChunk, untitled: string): string {
  if (row.title && row.title.trim().length > 0) return row.title.trim();
  const firstLine = row.content.split('\n')[0]?.trim();
  if (firstLine && firstLine.length > 0) return stripMarkdown(firstLine);
  return untitled;
}

/* ═══════════════════════════════════════════════════════════════════
 *                             FAQ CLIENT
 * ═══════════════════════════════════════════════════════════════════ */

export function FaqClient({
  locale,
  rows: initialRows,
  pendingCount: initialPendingCount,
}: Props) {
  const t = useTranslations('panel.faq');
  const tCommon = useTranslations('common');
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const [panel, setPanel] = useState<PanelMode>({ kind: 'empty' });
  const [deleteTarget, setDeleteTarget] = useState<FaqChunk | null>(null);
  const mobileSheet = useMobileSheet();

  const { data: rows = initialRows } = useQuery({
    queryKey: queryKeys.faq,
    queryFn: () => apiQuery<FaqChunk[]>('/api/faq'),
    initialData: initialRows,
    staleTime: 30_000,
  });

  const pendingCount = useMemo(
    () => rows.filter((r) => !r.hasEmbedding).length,
    [rows],
  );
  void initialPendingCount; // mantenido en la API por estabilidad server component

  // Re-sync: si borran el activo, volvemos a empty.
  useEffect(() => {
    if (
      panel.kind === 'edit' &&
      !rows.some((r) => r.id === panel.row.id)
    ) {
      setPanel({ kind: 'empty' });
      mobileSheet.close();
    }
  }, [rows, panel, mobileSheet]);

  const filtered = useMemo(() => {
    let out = rows;
    if (onlyPending) out = out.filter((r) => !r.hasEmbedding);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => {
        const title = (r.title ?? '').toLowerCase();
        const content = stripMarkdown(r.content).toLowerCase();
        return title.includes(q) || content.includes(q);
      });
    }
    return out;
  }, [rows, search, onlyPending]);

  const activeId = panel.kind === 'edit' ? panel.row.id : null;

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiMutation<void>(`/api/faq/${id}`, 'DELETE'),
    onSuccess: (_data, deletedId) => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: queryKeys.faq });
      if (panel.kind === 'edit' && panel.row.id === deletedId) {
        setPanel({ kind: 'empty' });
        mobileSheet.close();
      }
    },
    onError: () => {
      toast.error(t('deleteFailed'));
    },
    onSettled: () => setDeleteTarget(null),
  });

  function openCreate() {
    setPanel({ kind: 'create' });
    mobileSheet.openIfMobile();
  }

  function openEdit(r: FaqChunk) {
    setPanel({ kind: 'edit', row: r });
    mobileSheet.openIfMobile();
  }

  function closePanel() {
    setPanel({ kind: 'empty' });
    mobileSheet.close();
  }

  function handleFormSuccess(saved: FaqChunk, wasCreate: boolean) {
    setPanel({ kind: 'edit', row: saved });
    if (wasCreate) mobileSheet.close();
  }

  const panelContent =
    panel.kind === 'empty' ? (
      <EmptyPanel onCreate={openCreate} />
    ) : (
      <ArticleEditor
        key={panel.kind === 'edit' ? panel.row.id : 'new'}
        mode={panel}
        onClose={closePanel}
        onSuccess={handleFormSuccess}
        onDelete={(r) => setDeleteTarget(r)}
      />
    );

  // Banner "sin embedding" — arriba del split card via headerSlot del shell.
  // Se auto-oculta cuando todo está indexado.
  const headerSlot =
    pendingCount > 0 ? (
      <div
        role="status"
        className="shrink-0 rounded-md border border-amber-300 bg-amber-50 p-3"
      >
        <p className="text-sm font-medium text-amber-900">
          {t('notIndexedBanner', { count: pendingCount })}
        </p>
        <p className="mt-1 text-sm text-amber-800">{t('notIndexedHint')}</p>
      </div>
    ) : null;

  const sidebar = (
    <>
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
                aria-label={t('newArticle')}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t('new')}</span>
              </Button>
            </div>

            {/* Filtro "solo sin indexar" — solo visible cuando hay al menos una */}
            {pendingCount > 0 ? (
              <label className="flex cursor-pointer items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={onlyPending}
                  onChange={(e) => setOnlyPending(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border text-amber-600 focus:ring-amber-500"
                />
                {t('onlyPending', { count: pendingCount })}
              </label>
            ) : null}

            <p className="px-0.5 text-[11px] tabular-nums text-muted-foreground">
              {t('countLabel', { n: rows.length })}
              {(search || onlyPending) && filtered.length !== rows.length ? (
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
                  {search || onlyPending
                    ? t('noSearchResults')
                    : t('emptyList')}
                </p>
                {!search && !onlyPending ? (
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
            <ul
              role="listbox"
              aria-label={t('listAriaLabel')}
              className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1"
            >
              {filtered.map((r) => (
                <li key={r.id}>
                  <ArticleRow
                    row={r}
                    active={r.id === activeId}
                    onSelect={() => openEdit(r)}
                    locale={locale}
                    t={t}
                  />
                </li>
              ))}
            </ul>
          )}
    </>
  );

  return (
    <>
      <MasterDetailShell
        sidebar={sidebar}
        panel={panelContent}
        mobile={mobileSheet}
        mobileTitle={
          panel.kind === 'create'
            ? t('newTitle')
            : panel.kind === 'edit'
              ? t('editTitle')
              : ''
        }
        hidePanelInSheet={panel.kind === 'empty'}
        mobileSheetMaxWidth="sm:max-w-2xl"
        headerSlot={headerSlot}
      />

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
              {deleteTarget ? labelFor(deleteTarget, t('untitled')) : ''}
            </strong>
          ),
          warn: (chunks) => (
            <strong className="font-semibold text-destructive">{chunks}</strong>
          ),
        })}
        confirmLabel={t('delete')}
        cancelLabel={tCommon('cancel')}
        variant="destructive"
      />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            ARTICLE ROW
 * ═══════════════════════════════════════════════════════════════════ */

function ArticleRow({
  row: r,
  active,
  onSelect,
  locale,
  t,
}: {
  row: FaqChunk;
  active: boolean;
  onSelect: () => void;
  locale: string;
  t: ReturnType<typeof useTranslations<'panel.faq'>>;
}) {
  const title = labelFor(r, t('untitled'));
  const excerpt = stripMarkdown(r.content).slice(0, 120);
  const dateIso = r.updatedAt ?? r.createdAt;
  const dateFmt = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
  }).format(new Date(dateIso));

  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        'group relative flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-brand-50 text-foreground'
          : 'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-2.5 h-12 w-0.5 rounded-r-full bg-brand-600"
        />
      ) : null}
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </p>
        {r.hasEmbedding ? (
          <Badge
            variant="outline"
            aria-label={t('indexed')}
            className="shrink-0 border-brand-300 bg-brand-100 text-[10px] font-medium text-brand-800"
          >
            {t('indexed')}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            aria-label={t('notIndexedAriaLabel')}
            className="shrink-0 border-amber-300 bg-amber-100 text-[10px] font-medium text-amber-900"
          >
            {t('notIndexed')}
          </Badge>
        )}
      </div>
      <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
        {excerpt}
      </p>
      <p className="text-[10px] tabular-nums text-muted-foreground/80">
        {dateFmt}
      </p>
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════
 *                            EMPTY PANEL
 * ═══════════════════════════════════════════════════════════════════ */

function EmptyPanel({ onCreate }: { onCreate: () => void }) {
  const t = useTranslations('panel.faq');
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
          {/* Libro abierto estilizado */}
          <path
            d="M40 44 Q60 40, 60 48 L60 82 Q60 74, 40 78 Z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
            className="opacity-60"
          />
          <path
            d="M80 44 Q60 40, 60 48 L60 82 Q60 74, 80 78 Z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
            className="opacity-60"
          />
          {/* Líneas de "texto" */}
          <line
            x1="46"
            y1="54"
            x2="56"
            y2="54"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            className="opacity-40"
          />
          <line
            x1="46"
            y1="60"
            x2="56"
            y2="60"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            className="opacity-40"
          />
          <line
            x1="46"
            y1="66"
            x2="54"
            y2="66"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            className="opacity-40"
          />
          <line
            x1="64"
            y1="54"
            x2="74"
            y2="54"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            className="opacity-40"
          />
          <line
            x1="64"
            y1="60"
            x2="74"
            y2="60"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            className="opacity-40"
          />
          <line
            x1="64"
            y1="66"
            x2="72"
            y2="66"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            className="opacity-40"
          />
          {/* Sparkle amber */}
          <path
            d="M96 34l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
            className="fill-amber-400"
          />
          <path
            d="M26 82l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
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
 *                          ARTICLE EDITOR
 * ═══════════════════════════════════════════════════════════════════ */

function ArticleEditor({
  mode,
  onClose,
  onSuccess,
  onDelete,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; row: FaqChunk };
  onClose: () => void;
  onSuccess: (saved: FaqChunk, wasCreate: boolean) => void;
  onDelete: (r: FaqChunk) => void;
}) {
  const t = useTranslations('panel.faq');
  const qc = useQueryClient();
  const isEdit = mode.kind === 'edit';
  const row = isEdit ? mode.row : null;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<ArticleFormValues>({
    resolver: zodResolver(articleSchema),
    defaultValues: {
      title: row?.title ?? '',
      content: row?.content ?? '',
    },
  });

  useEffect(() => {
    reset({
      title: row?.title ?? '',
      content: row?.content ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  const titleValue = watch('title') ?? '';
  const contentValue = watch('content') ?? '';

  const saveMutation = useMutation({
    mutationFn: async (payload: {
      content: string;
      title?: string | null;
    }) => {
      if (!isEdit) {
        return apiMutation<FaqChunk, typeof payload>(
          '/api/faq',
          'POST',
          payload,
        );
      }
      return apiMutation<FaqChunk, typeof payload>(
        `/api/faq/${row!.id}`,
        'PATCH',
        payload,
      );
    },
    onSuccess: (saved) => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: queryKeys.faq });
      onSuccess(saved, !isEdit);
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: ArticleFormValues) {
    // Solo enviamos `title` cuando el operador lo tocó (undefined = no tocar
    // en el backend). En create, si viene vacío mandamos `null`.
    const payload: { content: string; title?: string | null } = {
      content: values.content,
    };
    if (!isEdit) {
      payload.title =
        values.title && values.title.length > 0 ? values.title : null;
    } else if (values.title !== undefined) {
      payload.title = values.title.length > 0 ? values.title : null;
    }
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
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 md:hidden"
            onClick={onClose}
            aria-label={t('back')}
            disabled={busy}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {isEdit ? t('editTitle') : t('newTitle')}
            </p>
            <h2 className="truncate text-base font-semibold text-foreground">
              {isEdit
                ? labelFor(row!, t('untitled'))
                : t('newSubtitle')}
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
              onClick={() => onDelete(row!)}
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
            className="hidden h-8 w-8 md:inline-flex"
            onClick={onClose}
            aria-label={t('close')}
            disabled={busy}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      {/* Body scrollable */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="article-title">{t('fields.title')}</Label>
          <Input
            id="article-title"
            maxLength={TITLE_MAX}
            placeholder={t('placeholders.title')}
            {...register('title')}
            disabled={busy}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              {t('hints.title')}
            </p>
            <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
              {t('counters.chars', {
                current: titleValue.length,
                max: TITLE_MAX,
              })}
            </p>
          </div>
          {errors.title ? (
            <p className="text-xs text-destructive">
              {t('errors.titleMax')}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="article-content"
            className="flex items-center gap-1.5"
          >
            <FileText
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            {t('fields.content')}
          </Label>
          <div id="article-content">
            <MarkdownEditor
              value={contentValue}
              onChange={(val) =>
                setValue('content', val, {
                  shouldValidate: true,
                  shouldDirty: true,
                })
              }
              height={420}
              preview="live"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              {t('hints.content')}
            </p>
            <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
              {t('counters.chars', {
                current: contentValue.length,
                max: CONTENT_MAX,
              })}
            </p>
          </div>
          {errors.content ? (
            <p className="text-xs text-destructive">{t('errors.content')}</p>
          ) : null}
        </div>
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
