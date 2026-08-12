import type { Config } from 'tailwindcss';

const config: Config = {
  // Dark mode con clase para poder activarlo más adelante sin re-configurar.
  darkMode: ['class'],
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        // Escala verde 50-900 — representa el CANAL de WhatsApp en la UI (mock
        // del hero, header de conversaciones, tokens de estado en el panel).
        // Se mantiene después del rebrand a Showly porque no es el brand del
        // producto, es el lenguaje visual del canal donde el producto opera.
        // Ver `src/components/ui/tokens.ts` para tokens derivados
        // (APPOINTMENT_STATUS_TOKENS, CONVERSATION_STATE_TOKENS, etc.).
        //
        // Los colores del brand Showly (navy + teal) viven como tokens planos
        // navy/teal debajo, alineados con el logo en `apps/web/public/favicon.svg`
        // y `showly-wordmark.svg`. Ver docs/notas/2026-08-11-brand-kit-showly.md.
        brand: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
          navy: '#0F2A4A',
          teal: '#28D9B9',
        },
        // Tokens semánticos shadcn/ui (leen variables CSS de globals.css).
        // Esto habilita que los componentes de shadcn (bg-primary, text-muted-foreground, etc.)
        // funcionen sin hardcodear colores. El tema light mapea --primary a brand-600 (verde).
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        // Inter — body/UI para toda la app (mejora legibilidad del panel también).
        // Cargada via next/font en el root layout como `--font-inter`.
        // También cubre todos los headings tras sacar Fraunces del sistema
        // (batch 2 anti-slop): usamos `font-sans font-bold/extrabold` en H1-H3.
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      // Bloque de motion cut de Hallmark: durations + easings tokenizados
      // para animar solo transform/opacity. No hay framer-motion en el proyecto.
      transitionTimingFunction: {
        'out-soft': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
