import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Nav } from '@/components/landing/Nav';
import { Footer } from '@/components/landing/Footer';
import { SecuritySection } from '@/components/landing/SecuritySection';

// Página standalone con el detalle de seguridad que antes vivía inline en
// la landing; la SecurityStrip enlaza acá.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'landing.securityPage' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  };
}

export default async function SeguridadPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <Nav />
      <main>
        <SecuritySection />
      </main>
      <Footer />
    </div>
  );
}
