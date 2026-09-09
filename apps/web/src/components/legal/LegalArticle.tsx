import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { Link } from '@/i18n/routing';

/**
 * LegalArticle — shell compartido por /privacidad y /terminos.
 *
 * Es un documento de lectura, no una landing: una sola columna estrecha
 * (max-w-3xl), tipografía de prosa y encabezado con eyebrow + título en
 * Fraunces, como el resto de las páginas públicas. La misma paleta cream/warm
 * del landing para que no se sienta un sitio distinto.
 *
 * El aviso "documento en revisión legal, versión piloto" va ARRIBA del
 * contenido, visible sin scroll: es el hecho más importante de la página
 * mientras no pase por un abogado (ver docs/adr/0004-pii-y-compliance.md).
 *
 * Las secciones y sus items vienen por props para que el copy viva 100 % en
 * `messages/*.json` bajo `legal.<page>.sections.<key>` y cada página declare
 * su orden. `items` (listas) es opcional por sección.
 */

export type LegalPageKey = 'privacy' | 'terms';

export interface LegalSectionDef {
  key: string;
  /** Keys de `sections.<key>.items.*` cuando la sección lleva lista. */
  items?: readonly string[];
}

interface Props {
  page: LegalPageKey;
  sections: readonly LegalSectionDef[];
}

export function LegalArticle({ page, sections }: Props) {
  // Namespace estático `legal` + keys por template: el shape de privacy/terms
  // difiere (secciones distintas), así que el key tipado no puede inferirse
  // desde `page`; el cast `as never` es el mismo patrón que PanelShell.
  const tl = useTranslations('legal');
  const tp = (key: string) => tl(`${page}.${key}` as never);
  const tc = useTranslations('legal.common');

  return (
    <article className="bg-cream-50 py-16 lg:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <header>
          <span className="text-xs font-medium uppercase tracking-widest text-brand-teal">
            {tp('eyebrow')}
          </span>
          <h1
            className="mt-3 font-display text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-brand-navy sm:text-5xl text-balance"
            style={{ overflowWrap: 'anywhere', fontOpticalSizing: 'auto' }}
          >
            {tp('title')}
          </h1>
          <p className="mt-2 text-sm text-warm-600">{tc('updatedAt')}</p>
          <p className="mt-6 text-lg leading-relaxed text-warm-600">
            {tp('intro')}
          </p>
        </header>

        {/* Aviso de borrador — role="note" para que los lectores de pantalla
            lo anuncien como contenido complementario, no como alerta. */}
        <div
          role="note"
          className="mt-8 flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900 sm:p-5"
        >
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0"
            aria-hidden="true"
            strokeWidth={1.75}
          />
          <div className="space-y-1 text-sm leading-relaxed">
            <p className="font-semibold">{tc('noticeTitle')}</p>
            <p>{tc('noticeBody')}</p>
          </div>
        </div>

        <div className="mt-12 space-y-10">
          {sections.map(({ key, items }) => (
            <section key={key} aria-labelledby={`legal-${page}-${key}`}>
              <h2
                id={`legal-${page}-${key}`}
                className="text-xl font-semibold tracking-tight text-brand-navy sm:text-2xl"
              >
                {tp(`sections.${key}.title`)}
              </h2>
              <p className="mt-3 text-base leading-relaxed text-warm-600">
                {tp(`sections.${key}.body`)}
              </p>
              {items ? (
                <ul className="mt-4 space-y-2 pl-5 text-base leading-relaxed text-warm-600 marker:text-brand-teal">
                  {items.map((item) => (
                    <li key={item} className="list-disc pl-1">
                      {tp(`sections.${key}.items.${item}`)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>

        <footer className="mt-14 border-t border-warm-200 pt-8">
          <p className="text-sm text-warm-600">
            {tc('contactLabel')}:{' '}
            <a
              href={`mailto:${tc('contactEmail')}`}
              className="font-medium text-brand-navy underline-offset-4 hover:underline"
            >
              {tc('contactEmail')}
            </a>
          </p>
          <nav
            aria-label={tc('contactLabel')}
            className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm"
          >
            <Link
              href="/"
              className="inline-flex min-h-11 items-center gap-1.5 text-brand-navy underline-offset-4 hover:underline"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {tc('backToHome')}
            </Link>
            {page === 'privacy' ? (
              <Link
                href="/terminos"
                className="inline-flex min-h-11 items-center text-brand-navy underline-offset-4 hover:underline"
              >
                {tc('seeAlsoTerms')}
              </Link>
            ) : (
              <Link
                href="/privacidad"
                className="inline-flex min-h-11 items-center text-brand-navy underline-offset-4 hover:underline"
              >
                {tc('seeAlsoPrivacy')}
              </Link>
            )}
            <Link
              href="/seguridad"
              className="inline-flex min-h-11 items-center text-brand-navy underline-offset-4 hover:underline"
            >
              {tc('seeAlsoSecurity')}
            </Link>
          </nav>
        </footer>
      </div>
    </article>
  );
}
