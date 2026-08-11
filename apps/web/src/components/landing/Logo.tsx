import { cn } from '@/lib/utils';

type LogoProps = {
  variant?: 'full' | 'mark';
  className?: string;
};

export function Logo({ variant = 'full', className }: LogoProps) {
  if (variant === 'mark') {
    return <LogoMark className={cn('h-7 w-7', className)} />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/showly-wordmark.svg"
      alt="Showly"
      width={188}
      height={56}
      draggable={false}
      className={cn('h-7 w-auto select-none', className)}
    />
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      role="img"
      aria-label="Showly"
      className={className}
    >
      <rect width="512" height="512" rx="112" fill="#0F2A4A" />
      <circle cx="256" cy="256" r="96" fill="#28D9B9" />
    </svg>
  );
}
