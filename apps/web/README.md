# apps/web — Next.js 15

Panel admin (por implementar) + **página pública** `/[locale]/agendar/[clinicSlug]`.

## Stack
- Next.js 15 (App Router) + React 19
- TypeScript strict, `moduleResolution: "bundler"`
- Tailwind CSS 3 + componentes UI hand-rolled (shadcn-style)
- next-intl v3 (es / pt) — locale siempre en la URL
- react-hook-form + zod para validación

## Correr local

```bash
# Desde la raíz del monorepo
pnpm install

# Levanta el backend (necesario)
pnpm dev:backend    # http://localhost:4000

# En otra terminal, levanta la web
pnpm dev:web        # http://localhost:3000
```

Abrí: `http://localhost:3000/es/agendar/{clinicSlug}` (por ejemplo `clinica-a`).

## Env vars

| Variable              | Default                  | Descripción                          |
| --------------------- | ------------------------ | ------------------------------------ |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000`  | URL base del backend NestJS.         |

## Estructura

```
src/
├── app/
│   └── [locale]/
│       ├── layout.tsx                       # HTML + NextIntlClientProvider
│       └── agendar/[clinicSlug]/
│           ├── page.tsx                     # SSR: fetchClinic + <ScheduleForm />
│           ├── ScheduleForm.tsx             # client: form + slots + submit
│           ├── not-found.tsx                # 404 si el slug no existe
│           └── gracias/page.tsx             # confirmación post-submit
├── components/ui/                           # Input, Button, Label, Select, Textarea
├── i18n/
│   ├── routing.ts                           # locales + navigation helpers
│   └── request.ts                           # getRequestConfig para next-intl
├── lib/
│   ├── api.ts                               # fetchClinic / fetchAvailability / createAppointment
│   └── utils.ts                             # cn()
├── middleware.ts                            # next-intl middleware
└── messages/                                # es.json / pt.json
```

## Notas de diseño

- **SSR estricto**: `fetchClinic` corre en el server sin cache (`cache: 'no-store'`).
- **Rate-limit y honeypot**: viven en el backend (`apps/backend/src/public`), no acá.
- **Fechas**: siempre formateamos con `Intl.DateTimeFormat` con la TZ de la clínica
  (nunca la del navegador).
