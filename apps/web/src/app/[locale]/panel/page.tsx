import { redirect } from 'next/navigation';

/**
 * `/[locale]/panel` sin sección explícita → redirige al dashboard.
 */
export default async function PanelIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/panel/dashboard`);
}
