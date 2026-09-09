/**
 * CTA de ventas por WhatsApp en la landing (sprint 2).
 *
 * `NEXT_PUBLIC_WHATSAPP_SALES` es build-time (se hornea en el bundle, igual
 * que Plausible). Se normaliza a sólo dígitos para `https://wa.me/<num>`.
 * Vacía o inválida → `null` y el CTA no se renderiza.
 */
export const WHATSAPP_SALES: string | null = (() => {
  const digits = (process.env.NEXT_PUBLIC_WHATSAPP_SALES ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
})();

/** Link wa.me con mensaje prellenado (ya urlencoded). */
export function whatsappSalesLink(message: string): string | null {
  if (!WHATSAPP_SALES) return null;
  return `https://wa.me/${WHATSAPP_SALES}?text=${encodeURIComponent(message)}`;
}
