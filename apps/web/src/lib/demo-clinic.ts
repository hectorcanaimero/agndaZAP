/**
 * Clínica demo pública de la landing (sección "Pruébalo ahora").
 *
 * Ambas son build-time (`NEXT_PUBLIC_*` se hornea en el bundle, igual que
 * `NEXT_PUBLIC_WHATSAPP_SALES`):
 * - `NEXT_PUBLIC_DEMO_WHATSAPP`: número del bot de la clínica demo, con código
 *   de país. Vacío o inválido → no se ofrece el WhatsApp demo.
 * - `NEXT_PUBLIC_DEMO_CLINIC_SLUG`: slug de la clínica demo para
 *   `/agendar/<slug>`. Vacío → no se ofrece la página demo.
 * Sin ninguna de las dos, la sección no se renderiza y el hero cae a
 * "Ver cómo funciona".
 */
export const DEMO_WHATSAPP: string | null = (() => {
  const digits = (process.env.NEXT_PUBLIC_DEMO_WHATSAPP ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
})();

export const DEMO_CLINIC_SLUG: string | null = (() => {
  const slug = (process.env.NEXT_PUBLIC_DEMO_CLINIC_SLUG ?? '').trim();
  return /^[a-z0-9-]{1,64}$/.test(slug) ? slug : null;
})();

export const demoAvailable = DEMO_WHATSAPP !== null || DEMO_CLINIC_SLUG !== null;

export function demoWhatsappLink(message: string): string | null {
  if (!DEMO_WHATSAPP) return null;
  return `https://wa.me/${DEMO_WHATSAPP}?text=${encodeURIComponent(message)}`;
}
