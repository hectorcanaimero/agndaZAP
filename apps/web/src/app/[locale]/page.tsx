import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Nav } from '@/components/landing/Nav';
import { Hero } from '@/components/landing/Hero';
import { Facts } from '@/components/landing/Facts';
import { ProblemSection } from '@/components/landing/ProblemSection';
import { Lifecycle } from '@/components/landing/Lifecycle';
import { FeaturesSection } from '@/components/landing/FeaturesSection';
import { PricingSection } from '@/components/landing/PricingSection';
import { SecurityStrip } from '@/components/landing/SecurityStrip';
import { FaqSection } from '@/components/landing/FaqSection';
import { FaqJsonLd } from '@/components/landing/FaqJsonLd';
import { FinalCta } from '@/components/landing/FinalCta';
import { Footer } from '@/components/landing/Footer';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'landing.meta' });
  return {
    title: t('title'),
    description: t('description'),
  };
}

export default async function LandingPage({
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
        <Hero />
        <Facts />
        <ProblemSection />
        <Lifecycle />
        <FeaturesSection />
        {/*
          Sin testimonios: no hay clínica en producción con un caso publicable
          y apps/web/PRODUCT.md prohíbe inventarlos. SecurityStrip (comprimida,
          link a /seguridad) después de Pricing para no competir con la venta.
        */}
        <PricingSection />
        <SecurityStrip />
        <FaqSection />
        <FaqJsonLd />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
