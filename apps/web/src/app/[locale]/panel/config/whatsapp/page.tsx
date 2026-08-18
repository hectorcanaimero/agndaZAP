import { redirect } from 'next/navigation';

/**
 * Redirect legacy → la config de WhatsApp vive ahora como tab dentro de
 * `/panel/ajustes`. Mantenemos esta ruta para no romper bookmarks del piloto
 * ni links viejos del nav. Si en el futuro no vemos hits en 6 meses, borrar.
 *
 * `redirect()` server-side devuelve 307 con Location — el browser sigue el
 * redirect sin cargar esta página cliente. Cero JS ejecutado.
 */
export default async function WhatsappConnectionPageLegacy({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/panel/ajustes?tab=whatsapp`);
}
