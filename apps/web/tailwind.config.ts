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
        // Mist: neutro frío con tinte navy para las superficies públicas
        // (landing, /seguridad, legales). Reemplaza cream/warm (2026-09-13):
        // crema + serif display era el look por defecto del "SaaS cálido" y
        // no es la marca; la marca es navy + teal. Ver
        // docs/adr/0025-landing-navy-teal-geist.md.
        mist: {
          50: '#F7F9FB',
          100: '#EEF2F6',
          200: '#DFE6EE',
          300: '#C3CEDA',
          500: '#66768C',
          600: '#4A5A70',
          700: '#33435A',
        },
        // Teal para TEXTO sobre fondos claros: #28D9B9 no llega a 4.5:1 sobre
        // mist-50, este sí. Mismo tono, más oscuro; el teal de marca sigue
        // siendo el de rellenos y marcas.
        'teal-ink': '#0A7A67',
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
        // Inter — body/UI, panel, superficies densas. Cargada via next/font
        // como `--font-inter`.
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Geist: display y cuerpo de las superficies públicas. Cargada via
        // next/font como `--font-geist`. El panel sigue en Inter (`sans`).
        display: ['var(--font-geist)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      transitionTimingFunction: {
        'out-soft': 'cubic-bezier(0.22, 1, 0.36, 1)',
        // back.out(1.4) para stagger de cards — pequeño overshoot cálido.
        'back-out': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
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
        // Usada por las cards del dashboard para entrar escalonadamente.
        // Solo opacity + transform → 60fps garantizado.
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-up': 'fade-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
      boxShadow: {
        // Sombra sutil para cards del dashboard — evita la sombra shadcn default
        // que se ve demasiado marcada sobre bg-gray-50.
        'card-flat': '0 1px 2px rgba(15, 23, 42, 0.04), 0 0 0 1px rgba(15, 23, 42, 0.03)',
        'card-lift': '0 8px 24px -8px rgba(15, 42, 74, 0.12), 0 2px 6px rgba(15, 42, 74, 0.06)',
        // Sombras con tinte navy para superficies públicas. Una sola
        // elevación por elemento: borde O sombra, no ambos.
        'lift-sm': '0 1px 2px rgba(15, 42, 74, 0.06), 0 1px 3px rgba(15, 42, 74, 0.05)',
        'lift-md': '0 6px 16px -4px rgba(15, 42, 74, 0.10), 0 2px 4px rgba(15, 42, 74, 0.05)',
        'lift-lg': '0 24px 48px -16px rgba(15, 42, 74, 0.22), 0 8px 16px -8px rgba(15, 42, 74, 0.10)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
