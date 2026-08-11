import { cn } from '@/lib/utils';

type LogoProps = {
  variant?: 'full' | 'mark';
  className?: string;
};

// Logo hand-built SVG. Símbolo: píldora verde brand con checkmark blanco
// inscrito (evoca la marca-check de WhatsApp — apropiado para agendamiento
// por chat — pero en el verde de la marca).
export function Logo({ variant = 'full', className }: LogoProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 select-none',
        variant === 'full' && 'text-xl font-semibold tracking-tight',
        className,
      )}
      aria-label="gochat"
    >
      <LogoMark className="h-7 w-7" />
      {variant === 'full' && (
        <span className="font-sans text-neutral-900 lowercase">gochat</span>
      )}
    </span>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-hidden="true"
      className={className}
    >
      {/* Píldora verde brand — hsl(142 76% 36%) tomado del token existente. */}
      <path
        d="M6 4h20a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6h-9l-6 5a1 1 0 0 1-1.6-.8V26H6a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6Z"
        fill="hsl(142 76% 36%)"
      />
      {/* Checkmark blanco — trazo grueso, redondeado, alto contraste WCAG AAA. */}
      <path
        d="m9 15.5 4.5 4.5L23 10"
        fill="none"
        stroke="#fff"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
