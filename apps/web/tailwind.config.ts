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
        // Cream / warm neutrals — el fondo del landing pasa a cream tint
        // en vez de white puro. Restar frialdad SaaS al instante sin tocar
        // el brand. Escalas cortas porque el uso es concentrado: bg de
        // superficies, hairlines, sombra base.
        cream: {
          50: '#FDFBF7',
          100: '#F9F5EE',
          200: '#F2ECDF',
        },
        warm: {
          50: '#FAF7F2',
          100: '#F1ECE1',
          200: '#E5DDCC',
          300: '#C9BFA9',
          600: '#7A6E55',
          900: '#2A2418',
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
        // Inter — body/UI, panel, superficies densas. Cargada via next/font
        // como `--font-inter`.
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Fraunces (opsz 144, SOFT 100, WONK 0) — display SOLO en H1/H2 de
        // landing pública. Serif humanist con curvas cálidas: rompe la
        // cuadratura visual del all-Inter sin caer en nostalgic.
        // Anti-brief del batch previo: allá era H1-H3, ahora scope acotado.
        display: [
          'var(--font-fraunces)',
          'ui-serif',
          'Georgia',
          'Cambria',
          'Times New Roman',
          'serif',
        ],
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
        // Warm shadows — tono cálido (marrón) en vez de blue-gray. Landing
        // pública usa estas para que las cards descansen sobre cream sin
        // sentir frío. Ver ProblemSection, FeaturesSection, PricingSection.
        'warm-sm': '0 1px 2px rgba(74, 55, 30, 0.05), 0 1px 3px rgba(74, 55, 30, 0.06)',
        'warm-md': '0 4px 12px -2px rgba(74, 55, 30, 0.08), 0 2px 4px rgba(74, 55, 30, 0.05)',
        'warm-lg': '0 20px 40px -12px rgba(74, 55, 30, 0.15), 0 8px 16px -8px rgba(74, 55, 30, 0.08)',
        'warm-xl': '0 32px 64px -16px rgba(74, 55, 30, 0.20), 0 16px 32px -16px rgba(74, 55, 30, 0.10)',
      },
      backgroundImage: {
        // Mesh gradient cálido para Hero — reemplaza el dot grid. Combina
        // teal muy transparente con cream para atmósfera sin gritar.
        'mesh-hero':
          'radial-gradient(at 15% 0%, rgba(40, 217, 185, 0.14) 0%, transparent 45%), radial-gradient(at 85% 20%, rgba(15, 42, 74, 0.08) 0%, transparent 50%), radial-gradient(at 50% 100%, rgba(249, 245, 238, 0.9) 0%, transparent 60%)',
        // Grain SVG data-uri, opacity muy baja. Solo textura, no ruido.
        grain:
          "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.28 0 0 0 0 0.22 0 0 0 0 0.15 0 0 0 0.55 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
