'use client';

/**
 * MarkdownEditor — wrapper cliente sobre @uiw/react-md-editor.
 *
 * Uso `next/dynamic` con `ssr: false` porque react-md-editor toca `window` en
 * el import inicial (highlighter, textarea autosize). Cargarlo en el server
 * rompería la hidratación de App Router.
 *
 * CSS: se importa acá y no en globals.css para mantener el bundle liviano.
 * Cualquier página que no use editor markdown no paga el costo.
 *
 * `data-color-mode="light"` fuerza el tema claro del editor; cuando agreguemos
 * dark mode al panel, esto va a leer del `next-themes` provider.
 */

import dynamic from 'next/dynamic';
import '@uiw/react-md-editor/markdown-editor.css';
import '@uiw/react-markdown-preview/markdown.css';

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), {
  ssr: false,
  loading: () => (
    <div
      className="h-96 w-full animate-pulse rounded-md bg-muted"
      aria-label="Cargando editor markdown"
    />
  ),
});

type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  height?: number;
  preview?: 'live' | 'edit' | 'preview';
};

export function MarkdownEditor({
  value,
  onChange,
  height = 500,
  preview = 'live',
}: MarkdownEditorProps) {
  return (
    <div data-color-mode="light">
      <MDEditor
        value={value}
        onChange={(val) => onChange(val ?? '')}
        height={height}
        preview={preview}
      />
    </div>
  );
}
