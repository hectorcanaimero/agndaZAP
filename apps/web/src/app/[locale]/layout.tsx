import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { Inter } from 'next/font/google';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { routing } from '@/i18n/routing';
import { QueryProvider } from '@/lib/query-provider';
import { Toaster } from '@/components/ui/sonner';
import '../globals.css';

// Inter — única fuente del sistema: body, UI, headings landing y panel.
// display: 'swap' evita el flash invisible mientras carga. Fraunces se sacó
// en el batch 2 (ver docs/notas): el serif no jugaba con el brand navy/teal
// y sumaba peso al bundle sin retorno visual claro.
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Showly',
  description: 'Agendá tu cita en un minuto.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'Showly',
    description: 'Agendá tu cita en un minuto.',
    images: ['/og-image.png'],
    type: 'website',
  },
};

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
    <html lang={locale} className={inter.variable}>
      <body className="antialiased font-sans">
        <QueryProvider>
          <NextIntlClientProvider messages={messages} locale={locale}>
            {children}
            <Toaster richColors position="top-right" />
          </NextIntlClientProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
