'use client';

/**
 * FaqClient — "Base de conocimiento" con split view.
 *
 * Layout:
 * - Desktop (>= md): dos columnas. Izquierda (~2/5) lista de artículos,
 *   derecha (~3/5) editor markdown + preview.
 * - Mobile (< md): stack de una columna. Muestra lista por defecto; al
 *   seleccionar o crear un artículo, muestra el editor y oculta la lista.
 *   Botón "Volver" arriba del editor devuelve al listado.
 *
 * Estado:
 * - `selectedId`: id del artículo elegido, o `null` si no hay ninguno.
 * - `mode`: 'idle' | 'edit' | 'create'. Distingue "nada seleccionado"
 *   (idle placeholder) vs "editando existente" vs "creando nuevo".
 *
 * Guardado explícito con botón (no auto-save) — evita race conditions con el
 * re-embed del backend que corre en cada PATCH.
 *
 * Fetching: TanStack Query hidratado desde el server-fetch inicial vía
 * `initialData`. Toda mutation invalida `queryKeys.faq` → refetch automático.
 * Reemplaza el patrón previo de `router.refresh()`.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { apiMutation, apiQuery } from '@/lib/query-fn';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type { FaqChunk } from './page';

const TITLE_MAX = 200;
const CONTENT_MIN = 5;
const CONTENT_MAX = 4000;

/**
 * Schema de validación cliente. `title` opcional (200 chars max), `content`
 * requerido (5-4000 chars). El backend re-valida — este schema es UX.
 */
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
  /** Cantidad de FAQs sin indexar (hasEmbedding=false). Si > 0 mostramos
   * banner amarillo persistente arriba de la lista. */
  pendingCount: number;
}

/**
 * Strippea markdown para preview limpio en la lista. Regex simple — no vale
 * la pena tirar `remark` acá porque el output es lossy pero human-readable:
 * quita headers, bold/italic, backticks, links (deja el texto), y colapsa
 * saltos de línea. Solo para excerpt de 2 líneas en las cards.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/_([^_]+)_/g, '$1') // underscore italic
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^\s*[-*+]\s+/gm, '') // list markers
    .replace(/^\s*>\s+/gm, '') // blockquotes
    .replace(/\n{2,}/g, ' ') // paragraph breaks
    .replace(/\n/g, ' ')
    .trim();
}

/**
 * Título mostrado para un artículo. Prioridad: `title` explícito → primera
 * línea del content strippeado → `untitled` como último fallback.
 */
function labelFor(row: FaqChunk, untitled: string): string {
  if (row.title && row.title.trim().length > 0) return row.title.trim();
  const firstLine = row.content.split('\n')[0]?.trim();
  if (firstLine && firstLine.length > 0) return stripMarkdown(firstLine);
  return untitled;
}

export function FaqClient({
  locale,
  rows: initialRows,
  pendingCount: initialPendingCount,
}: Props) {
  const t = useTranslations('panel.faq');
  const tCommon = useTranslations('common');
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'edit' | 'create'>('idle');
  const [deleteTarget, setDeleteTarget] = useState<FaqChunk | null>(null);

  const { data: rows = initialRows } = useQuery({
    queryKey: queryKeys.faq,
    queryFn: () => apiQuery<FaqChunk[]>('/api/faq'),
    initialData: initialRows,
  });

  /*
   * `pendingCount` se deriva de `rows` — recalcular acá en vez de recibirlo
   * del SSR permite que el banner se actualice tras un save/delete sin
   * requerir un router.refresh. En la primera render el valor coincide con el
   * `initialPendingCount` (por eso el fallback es semánticamente idéntico).
   */
  const pendingCount = useMemo(
    () => rows.filter((r) => !r.hasEmbedding).length,
    [rows],
  );
  void initialPendingCount; // silenciar unused — el prop se mantiene por API estable con el server component.

  // Re-sync cuando `rows` cambia (post-refetch): si el seleccionado ya no
  // existe, volvemos a idle. Evita mostrar un editor con datos stale.
  useEffect(() => {
    if (selectedId && !rows.some((r) => r.id === selectedId)) {
      setSelectedId(null);
      setMode('idle');
    }
  }, [rows, selectedId]);

  const selectedRow = useMemo(
    () => (selectedId ? rows.find((r) => r.id === selectedId) ?? null : null),
    [rows, selectedId],
  );

  function handleSelect(row: FaqChunk) {
    setSelectedId(row.id);
    setMode('edit');
  }

  function handleCreate() {
    setSelectedId(null);
    setMode('create');
  }

  function handleBack() {
    setSelectedId(null);
    setMode('idle');
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiMutation<void>(`/api/faq/${id}`, 'DELETE'),
    onSuccess: (_data, id) => {
      toast.success(t('deleted'));
      if (selectedId === id) {
        setSelectedId(null);
        setMode('idle');
      }
      void qc.invalidateQueries({ queryKey: queryKeys.faq });
    },
    onError: () => {
      toast.error(t('deleteFailed'));
    },
    onSettled: () => setDeleteTarget(null),
  });

  function performDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id);
  }

  return (
    <div className="space-y-4">
      {/*
        Banner amarillo persistente cuando hay FAQs sin embedding.
        - `role="status"` (no `alert`) porque es info persistente, no
          interrupción. Screen reader lo anuncia cuando aparece, pero no
          interrumpe navegación.
        - Copy incluye pluralización via ICU y hint técnico.
      */}
      {pendingCount > 0 ? (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-3"
        >
          <p className="text-sm font-medium text-amber-900">
            {t('notIndexedBanner', { count: pendingCount })}
          </p>
          <p className="mt-1 text-sm text-amber-800">{t('notIndexedHint')}</p>
        </div>
      ) : null}

      {/*
        Split view:
        - Desktop (md+): grid 2 cols (3fr / 7fr = 30/70) siempre visible.
          Damos más espacio al editor markdown, que necesita ancho para
          renderizar toolbar + preview live cómodamente. La lista con cards
          angostos-medianos sigue leyéndose bien con truncate + line-clamp.
        - Mobile: stack — la lista se oculta cuando estamos en editor
          (mode !== 'idle'), y el editor se oculta cuando estamos en la lista
          (mode === 'idle'). Un solo componente, dos states visuales.
      */}
      <div className="grid gap-4 md:grid-cols-[360px_1fr]">
        <ArticleList
          rows={rows}
          selectedId={selectedId}
          mode={mode}
          locale={locale}
          onSelect={handleSelect}
          onCreate={handleCreate}
          untitledLabel={t('untitled')}
          indexedLabel={t('indexed')}
          notIndexedLabel={t('notIndexed')}
          notIndexedAriaLabel={t('notIndexedAriaLabel')}
          emptyLabel={t('empty')}
          newArticleLabel={t('newArticle')}
        />

        <ArticleEditor
          key={mode === 'create' ? 'create' : (selectedRow?.id ?? 'idle')}
          mode={mode}
          row={selectedRow}
          onBack={handleBack}
          onDeleteRequest={(row) => setDeleteTarget(row)}
          onSaved={() => {
            if (mode === 'create') {
              // Tras crear volvemos a idle en mobile; en desktop la lista se
              // refresca (via invalidate) y el operador puede tocar la card
              // recién creada.
              setMode('idle');
              setSelectedId(null);
            }
          }}
        />
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={performDelete}
        title={t('confirmDelete.title')}
        description={t.rich('confirmDelete.description', {
          name: () => (
            <strong className="font-semibold text-gray-900">
              {deleteTarget ? labelFor(deleteTarget, t('untitled')) : ''}
            </strong>
          ),
          warn: (chunks) => (
            <strong className="font-semibold text-red-700">{chunks}</strong>
          ),
        })}
        confirmLabel={t('delete')}
        cancelLabel={tCommon('cancel')}
        variant="destructive"
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* ArticleList                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

interface ArticleListProps {
  rows: FaqChunk[];
  selectedId: string | null;
  mode: 'idle' | 'edit' | 'create';
  locale: string;
  onSelect: (row: FaqChunk) => void;
  onCreate: () => void;
  untitledLabel: string;
  indexedLabel: string;
  notIndexedLabel: string;
  notIndexedAriaLabel: string;
  emptyLabel: string;
  newArticleLabel: string;
}

function ArticleList({
  rows,
  selectedId,
  mode,
  locale,
  onSelect,
  onCreate,
  untitledLabel,
  indexedLabel,
  notIndexedLabel,
  notIndexedAriaLabel,
  emptyLabel,
  newArticleLabel,
}: ArticleListProps) {
  // Mobile: si estamos en editor (mode !== idle) escondemos la lista.
  // Desktop (md+): siempre visible via `md:block`.
  const hideOnMobile = mode !== 'idle';

  function fmt(iso: string): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(
      new Date(iso),
    );
  }

  return (
    <aside
      className={cn(
        'space-y-3',
        hideOnMobile ? 'hidden md:block' : 'block',
      )}
    >
      <div className="flex justify-end">
        <Button onClick={onCreate}>+ {newArticleLabel}</Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 bg-white p-8 text-center">
          <div
            aria-hidden="true"
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
            </svg>
          </div>
          <p className="text-sm text-gray-600">{emptyLabel}</p>
          <div className="mt-4">
            <Button onClick={onCreate}>+ {newArticleLabel}</Button>
          </div>
        </div>
      ) : (
        <ul
          role="listbox"
          aria-label={newArticleLabel}
          className="space-y-2"
        >
          {rows.map((r) => {
            const active = r.id === selectedId && mode === 'edit';
            const title = labelFor(r, untitledLabel);
            const excerpt = stripMarkdown(r.content).slice(0, 160);
            const dateIso = r.updatedAt ?? r.createdAt;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => onSelect(r)}
                  className={cn(
                    'w-full rounded-md border bg-white p-4 text-left transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                    active
                      ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
                  )}
                >
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate font-medium text-gray-900">
                      {title}
                    </p>
                    {r.hasEmbedding ? (
                      <Badge
                        variant="outline"
                        aria-label={indexedLabel}
                        className="shrink-0 border-brand-300 bg-brand-100 text-brand-800"
                      >
                        {indexedLabel}
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        aria-label={notIndexedAriaLabel}
                        className="shrink-0 border-amber-300 bg-amber-100 text-amber-900"
                      >
                        {notIndexedLabel}
                      </Badge>
                    )}
                  </div>
                  <p className="line-clamp-3 text-sm text-gray-600">
                    {excerpt}
                  </p>
                  <p className="mt-2 text-xs text-gray-500 tabular-nums">
                    {fmt(dateIso)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* ArticleEditor                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

interface ArticleEditorProps {
  mode: 'idle' | 'edit' | 'create';
  row: FaqChunk | null;
  onBack: () => void;
  onDeleteRequest: (row: FaqChunk) => void;
  onSaved: () => void;
}

function ArticleEditor({
  mode,
  row,
  onBack,
  onDeleteRequest,
  onSaved,
}: ArticleEditorProps) {
  const t = useTranslations('panel.faq');
  const tCommon = useTranslations('common');
  const qc = useQueryClient();

  // Mobile: si estamos en idle escondemos el editor (la lista ocupa toda
  // la pantalla). Desktop (md+): siempre visible.
  const hideOnMobile = mode === 'idle';

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ArticleFormValues>({
    resolver: zodResolver(articleSchema),
    defaultValues: {
      title: row?.title ?? '',
      content: row?.content ?? '',
    },
  });

  const titleValue = watch('title') ?? '';
  const contentValue = watch('content') ?? '';

  const saveMutation = useMutation({
    mutationFn: async (
      payload: { content: string; title?: string | null },
    ) => {
      if (mode === 'create') {
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
    onSuccess: () => {
      // Nota: fetcher NO expone headers de respuesta. El X-Warning
      // 'embedding-skipped-no-openai-key' llegaría acá si expusiéramos
      // headers, pero se infiere igual del `hasEmbedding: false` que ya
      // renderiza el banner y las badges. Toast success solo.
      toast.success(t('saved'));
      reset();
      void qc.invalidateQueries({ queryKey: queryKeys.faq });
      onSaved();
    },
    onError: () => {
      toast.error(t('saveFailed'));
    },
  });

  async function onSubmit(values: ArticleFormValues) {
    const payload: { content: string; title?: string | null } = {
      content: values.content,
    };
    // Solo enviamos `title` cuando el operador lo tocó (undefined = no tocar
    // en el backend). En create, si viene vacío mandamos `null` para
    // consistencia con el fallback UI.
    if (mode === 'create') {
      payload.title = values.title && values.title.length > 0 ? values.title : null;
    } else if (values.title !== undefined) {
      payload.title = values.title.length > 0 ? values.title : null;
    }

    await saveMutation.mutateAsync(payload).catch(() => {
      /* onError toasted */
    });
  }

  if (hideOnMobile) {
    // En mobile ocultamos completamente el editor mientras estamos en la
    // lista. En desktop mostramos el placeholder.
    return (
      <section
        className={cn(
          'hidden rounded-md border border-dashed border-gray-300 bg-white p-8 md:flex md:min-h-[500px] md:flex-col md:items-center md:justify-center md:text-center',
        )}
      >
        <div
          aria-hidden="true"
          className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-500"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M16 13H8" />
            <path d="M16 17H8" />
            <path d="M10 9H8" />
          </svg>
        </div>
        <p className="max-w-sm text-sm text-gray-600">{t('selectOrCreate')}</p>
      </section>
    );
  }

  return (
    <section
      className={cn(
        'flex flex-col gap-4 rounded-md border border-gray-200 bg-white p-4 md:p-6',
      )}
    >
      {/* Botón Volver: visible siempre en mobile. En desktop lo mostramos
          igual (útil para "salir" del editor sin tocar la lista). */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 py-1 text-sm text-brand-700 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={t('back')}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          {t('back')}
        </button>
        <h2 className="text-lg font-semibold text-gray-900">
          {mode === 'create' ? t('newTitle') : t('editTitle')}
        </h2>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1">
          <Label htmlFor="article-title">{t('fields.title')}</Label>
          <Input
            id="article-title"
            maxLength={TITLE_MAX}
            placeholder={t('placeholders.title')}
            {...register('title')}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-gray-500">{t('hints.title')}</p>
            <p className="shrink-0 text-xs text-gray-400 tabular-nums">
              {t('counters.chars', {
                current: titleValue.length,
                max: TITLE_MAX,
              })}
            </p>
          </div>
          {errors.title ? (
            <p className="text-xs text-red-600">{t('errors.titleMax')}</p>
          ) : null}
        </div>

        <div className="space-y-1">
          <Label htmlFor="article-content">{t('fields.content')}</Label>
          <div id="article-content">
            <MarkdownEditor
              value={contentValue}
              onChange={(val) =>
                setValue('content', val, {
                  shouldValidate: true,
                  shouldDirty: true,
                })
              }
              height={500}
              preview="live"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-gray-500">{t('hints.content')}</p>
            <p className="shrink-0 text-xs text-gray-400 tabular-nums">
              {t('counters.chars', {
                current: contentValue.length,
                max: CONTENT_MAX,
              })}
            </p>
          </div>
          {errors.content ? (
            <p className="text-xs text-red-600">{t('errors.content')}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          {mode === 'edit' && row ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => onDeleteRequest(row)}
              className="mr-auto"
            >
              {t('delete')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onBack}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting || saveMutation.isPending}>
            {isSubmitting || saveMutation.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </section>
  );
}
