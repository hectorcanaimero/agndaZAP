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
import { SecuritySection } from '@/components/landing/SecuritySection';
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
          - ForWhom antes de Security para que el visitante primero se
            auto-identifique ("¿es para mi consultorio?") y RECIEN AHI le
            respondamos "¿y los datos de mis pacientes?" — la barrera #1
            en healthcare.
          - Security antes de FAQ: cerramos la objeción sensible con peso
            propio (fondo oscuro, mismo tratamiento que Testimonial) y
            dejamos que el FAQ resuelva las dudas menores.
          - Testimonial JUSTO antes de FinalCta — patrón probado
            "social proof → CTA" (levantamos confianza inmediatamente
            antes de pedir la acción).
        */}
        <PricingSection />
        <ForWhomSection />
        <SecuritySection />
        <FaqSection />
        <Testimonial />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
