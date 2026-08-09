import type { ReactNode } from 'react';
import { Fraunces, Geist, Geist_Mono } from 'next/font/google';

/**
 * Fuentes distintivas cargadas SOLO para esta ruta — no globales al panel.
 * Fraunces variable (display serif contemporánea) para títulos y números;
 * Geist para body/UI y Geist Mono para tabular-nums (teléfonos, timestamps).
 * Se exponen como CSS variables para usarlas via Tailwind arbitrary values.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-conv-display',
  axes: ['SOFT', 'opsz'],
});

const geist = Geist({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-conv-sans',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-conv-mono',
});

export default function ConversacionesLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div
      className={`${fraunces.variable} ${geist.variable} ${geistMono.variable} h-full`}
    >
      {children}
    </div>
  );
}
