import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { Geist, Inter } from 'next/font/google';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { routing } from '@/i18n/routing';
import { QueryProvider } from '@/lib/query-provider';
import { Toaster } from '@/components/ui/sonner';
import { Analytics } from '@/components/analytics/Analytics';
import { SkipToContent } from '@/components/a11y/SkipToContent';
import { OrganizationJsonLd } from '@/components/seo/OrganizationJsonLd';
import { getSiteUrl } from '@/lib/site-url';
import '../globals.css';

// Inter — body/UI en TODO el sistema (landing, panel, admin).
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-inter',
  display: 'swap',
});

// Geist — display y cuerpo de las superficies públicas (landing, /seguridad,
// legales) vía `font-display`. Variable: un solo archivo cubre 400-700.
const geist = Geist({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-geist',
  display: 'swap',
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'landing.meta' });

  return {
    // Base absoluta para OG images y canonical; ver `lib/site-url.ts`.
    metadataBase: new URL(getSiteUrl()),
    title: 'Showly',
    description: t('description'),
    icons: {
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
        { url: '/favicon.ico', sizes: 'any' },
      ],
      apple: '/apple-touch-icon.png',
    },
    openGraph: {
      title: 'Showly',
      description: t('description'),
      images: ['/og-image.png'],
      type: 'website',
    },
  };
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as 'es' | 'pt')) {
    notFound();
  }

  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={`${inter.variable} ${geist.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased font-sans" suppressHydrationWarning>
        <OrganizationJsonLd />
        <QueryProvider>
          <NextIntlClientProvider messages={messages} locale={locale}>
            <SkipToContent />
            {children}
            <Toaster richColors position="top-right" />
            <Analytics />
          </NextIntlClientProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
