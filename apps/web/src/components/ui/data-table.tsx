'use client';

/**
 * DataTable — wrapper shadcn + TanStack Table v8 (headless).
 *
 * Provee:
 * - Sorting por columna (click en header con `column.toggleSorting`).
 * - Filtro global por texto (search input arriba). Se activa con `searchKey`.
 * - Column visibility (dropdown para mostrar/ocultar columnas).
 * - Paginación (20 por página, botones prev/next si `pageCount > 1`).
 *
 * Diseñado como el "gemelo" desktop de las cards mobile — cada CRUD envuelve
 * este componente en `<div className="hidden md:block">` y mantiene su bloque
 * de cards `<div className="md:hidden">` para preservar el patrón del spec UX
 * `docs/ux/2026-08-09-panel-tables-a-cards-en-mobile.md`.
 *
 * Notas de tipos:
 * - `TData` es la fila (Service, Professional, etc.). `TValue` queda genérico
 *   para permitir columnas heterogéneas (number, string, array).
 * - `searchKey` es tipado sobre `keyof TData` pero solo se usa como sugerencia
 *   — el filtro global de TanStack usa `getFilteredRowModel` que matchea
 *   contra TODOS los valores accesibles de la fila, no solo la columna
 *   indicada. Sirve principalmente para decidir si mostrar el input o no.
 */

import {
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Columns3, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /**
   * Si se pasa, se muestra el input de búsqueda global arriba de la tabla.
   * El filtro corre sobre toda la fila (TanStack default), no solo esta key
   * — la key sirve para gatillar la UI y como hint semántico.
   */
  searchKey?: keyof TData;
  searchPlaceholder?: string;
  emptyMessage?: string;
  /**
   * Etiquetas legibles por columna id para el toggle de columnas. Sin esto,
   * el dropdown muestra `column.id` crudo (útil para debug pero feo en prod).
   */
  columnLabels?: Record<string, string>;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchKey,
  searchPlaceholder,
  emptyMessage,
  columnLabels,
}: DataTableProps<TData, TValue>) {
  const t = useTranslations('common');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  });

  const hideableColumns = table.getAllColumns().filter((c) => c.getCanHide());
  const showToolbar = Boolean(searchKey) || hideableColumns.length > 0;

  return (
    <div className="space-y-3">
      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {searchKey ? (
            <div className="relative w-full max-w-xs flex-1">
              <Search
                aria-hidden="true"
                className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                placeholder={searchPlaceholder ?? t('search')}
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                className="pl-8"
                aria-label={searchPlaceholder ?? t('search')}
              />
            </div>
          ) : null}
          {hideableColumns.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="ml-auto">
                  <Columns3 className="mr-2 h-4 w-4" />
                  {t('columns')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {hideableColumns.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(v) => column.toggleVisibility(!!v)}
                    // Evitamos que el menú se cierre al togglear una col.
                    onSelect={(e) => e.preventDefault()}
                  >
                    {columnLabels?.[column.id] ?? column.id}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
        <Table>
          <TableHeader className="bg-gray-50">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="px-3 py-2">
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {emptyMessage ?? t('empty')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {table.getPageCount() > 1 ? (
        <div className="flex items-center justify-end gap-2">
          <span className="text-sm text-muted-foreground tabular-nums">
            {t('page')} {table.getState().pagination.pageIndex + 1} /{' '}
            {table.getPageCount()}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label={t('previous')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label={t('next')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
