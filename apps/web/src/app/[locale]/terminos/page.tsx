import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Nav } from '@/components/landing/Nav';
import { Footer } from '@/components/landing/Footer';
import {
  LegalArticle,
  type LegalSectionDef,
} from '@/components/legal/LegalArticle';

// Términos de uso — BORRADOR para el piloto gratuito. El copy vive en
// `legal.terms.*` (es/pt); acá sólo el orden de las secciones.
const SECTIONS: readonly LegalSectionDef[] = [
  { key: 'service' },
  { key: 'pilot' },
  { key: 'availability' },
  { key: 'clinic' },
  { key: 'acceptableUse' },
  { key: 'data' },
  { key: 'cancellation' },
  { key: 'liability' },
  { key: 'changes' },
];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'legal.terms' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  };
}

export default async function TerminosPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <Nav />
      <main id="main" tabIndex={-1}>
        <LegalArticle page="terms" sections={SECTIONS} />
      </main>
      <Footer />
    </div>
  );
}
