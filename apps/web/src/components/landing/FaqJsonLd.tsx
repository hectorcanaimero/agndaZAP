import { useTranslations } from 'next-intl';
import { JsonLd } from '@/components/seo/JsonLd';

// Misma lista que `FaqSection.QUESTIONS`. Se duplica a propósito: FaqSection
// no exporta la constante y no la tocamos en este PR; si se agrega una
// pregunta hay que sumarla en los dos lados (el copy sigue viniendo de
// `landing.faq.items.*`, así que el texto nunca se desincroniza).
const QUESTIONS = [
  'phone',
  'install',
  'business',
  'onboarding',
  'privacy',
  'price',
] as const;

/**
 * `FAQPage` JSON-LD para rich results. Se renderiza junto a FaqSection en
 * la landing; no pinta nada visible.
 */
export function FaqJsonLd() {
  const t = useTranslations('landing.faq');
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: QUESTIONS.map((q) => ({
          '@type': 'Question',
          name: t(`items.${q}.question`),
          acceptedAnswer: {
            '@type': 'Answer',
            text: t(`items.${q}.answer`),
          },
        })),
      }}
    />
  );
}
