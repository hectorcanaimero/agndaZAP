import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { Fraunces, Inter } from 'next/font/google';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { routing } from '@/i18n/routing';
import { QueryProvider } from '@/lib/query-provider';
import { Toaster } from '@/components/ui/sonner';
import '../globals.css';

// Inter — body/UI para toda la app (mejora la legibilidad del panel también).
// display: 'swap' evita el flash invisible mientras carga.
const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-inter',
  display: 'swap',
});

// Fraunces — display serif para la landing (`font-display`).
// Roman only — Hallmark prohíbe italic headers.
const fraunces = Fraunces({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-fraunces',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'Showly',
  description: 'Agendá tu cita en un minuto.',
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
    <html lang={locale} className={`${inter.variable} ${fraunces.variable}`}>
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
