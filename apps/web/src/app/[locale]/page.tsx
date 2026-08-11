import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Nav } from '@/components/landing/Nav';
import { Hero } from '@/components/landing/Hero';
import { ProblemSection } from '@/components/landing/ProblemSection';
import { HowItWorksSection } from '@/components/landing/HowItWorksSection';
import { FeaturesSection } from '@/components/landing/FeaturesSection';
import { PricingSection } from '@/components/landing/PricingSection';
import { Testimonial } from '@/components/landing/Testimonial';
import { ForWhomSection } from '@/components/landing/ForWhomSection';
import { FaqSection } from '@/components/landing/FaqSection';
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
      <main>
        <Hero />
        <ProblemSection />
        <HowItWorksSection />
        <FeaturesSection />
        {/*
          Orden narrativo:
          - Pricing DESPUES de Features: primero convencemos de qué hace,
            luego respondemos "¿cuánto cuesta?" antes de que el visitante
            se vaya buscándolo en el FAQ.
          - ForWhom antes de FAQ para que el visitante se auto-identifique
            ("¿es para mi consultorio?") antes de las preguntas de detalle.
          - Testimonial JUSTO antes de FinalCta — patrón probado
            "social proof → CTA" (levantamos confianza inmediatamente
            antes de pedir la acción).
        */}
        <PricingSection />
        <ForWhomSection />
        <FaqSection />
        <Testimonial />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
