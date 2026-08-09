import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { routing } from '@/i18n/routing';
import { QueryProvider } from '@/lib/query-provider';
import { Toaster } from '@/components/ui/sonner';
import '../globals.css';

export const metadata: Metadata = {
  title: 'AgendaZap',
  description: 'Agendá tu cita en un minuto.',
};

/**
 * Layout por locale. Provee `<html lang>` correcto según el segmento `[locale]`
 * y monta el `NextIntlClientProvider` para que los client components accedan
 * a `useTranslations`.
 *
 * Static params: pre-generamos los locales conocidos para SSG cuando aplique.
 */
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

  // Validamos que el locale sea uno soportado; caso contrario 404.
  if (!routing.locales.includes(locale as 'es' | 'pt')) {
    notFound();
  }

  // Habilita features estáticas para el request actual.
  setRequestLocale(locale);

  // Carga los mensajes del locale para hidratar al cliente.
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body className="antialiased">
        {/*
          Orden: QueryProvider (más externo) → NextIntlClientProvider → children.
          Razón: hooks tipo `useSomethingQuery` pueden querer leer traducciones
          en su `select`/`onError`; con este orden ambas capas ven al provider
          hermano si lo necesitan, y los devtools de Query envuelven todo.
        */}
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
