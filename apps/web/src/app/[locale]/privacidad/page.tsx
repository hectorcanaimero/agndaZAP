import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Nav } from '@/components/landing/Nav';
import { Footer } from '@/components/landing/Footer';
import {
  LegalArticle,
  type LegalSectionDef,
} from '@/components/legal/LegalArticle';

// Política de privacidad — BORRADOR para el piloto. El copy vive en
// `legal.privacy.*` (es/pt). Orden y listas de cada sección se declaran acá;
// el texto, en messages. Ver docs/adr/0004-pii-y-compliance.md para el
// estado real de PII/PHI que este documento describe.
const SECTIONS: readonly LegalSectionDef[] = [
  { key: 'controller' },
  {
    key: 'data',
    items: ['name', 'phone', 'messages', 'appointments', 'health'],
  },
  { key: 'purpose' },
  { key: 'sharing', items: ['whatsapp', 'ai', 'hosting'] },
  { key: 'retention' },
  {
    key: 'rights',
    items: ['access', 'rectify', 'delete', 'portability', 'revoke'],
  },
  { key: 'exercise' },
  { key: 'changes' },
];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'legal.privacy' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  };
}

export default async function PrivacidadPage({
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
        <LegalArticle page="privacy" sections={SECTIONS} />
      </main>
      <Footer />
    </div>
  );
}
