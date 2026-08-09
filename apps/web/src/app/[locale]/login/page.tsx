import { setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

/**
 * Login page — server component wrapper. La lógica del form vive en `LoginForm`
 * (client) para poder usar rhf + zod + fetch al backend.
 *
 * `LoginForm` usa `useSearchParams()` (para leer `?next=`) — Next 15 exige
 * envolverlo en `<Suspense>` para no bailar del prerender.
 */
export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8">
      <Suspense fallback={<div className="text-sm text-gray-500">…</div>}>
        <LoginForm locale={locale} />
      </Suspense>
    </main>
  );
}
