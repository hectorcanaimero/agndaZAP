'use client';

/**
 * MarkdownPreview — render read-only de markdown con estilos GitHub-like.
 *
 * Igual que MarkdownEditor, se carga vía `next/dynamic` sin SSR: el paquete
 * hace side effects sobre `window` en import. La clase `prose` se deja para
 * futuros ajustes con @tailwindcss/typography si se instala; hoy solo suma
 * ancho máximo y márgenes suaves.
 */

import dynamic from 'next/dynamic';
import '@uiw/react-markdown-preview/markdown.css';

const MarkdownPreviewComponent = dynamic(
  () => import('@uiw/react-markdown-preview').then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-48 w-full animate-pulse rounded-md bg-muted"
        aria-label="Cargando preview markdown"
      />
    ),
  },
);

type MarkdownPreviewProps = {
  source: string;
};

export function MarkdownPreview({ source }: MarkdownPreviewProps) {
  return (
    <div data-color-mode="light" className="prose prose-sm max-w-none">
      <MarkdownPreviewComponent source={source} />
    </div>
  );
}
