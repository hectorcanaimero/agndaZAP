/**
 * Inyecta un bloque `application/ld+json`. Escapamos `<` para que ningún
 * string del payload pueda cerrar el <script> (XSS clásico con JSON-LD).
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, '\\u003c'),
      }}
    />
  );
}
