// Shared visual primitives for the "Neutral Teal" design language (handoff).
// These are presentation-only: no data, no app state. Feature tabs compose
// them so cards, chips, status dots and toggles stay pixel-consistent.

import type { ReactNode } from 'react';

/** Tiny class-name joiner (no dependency on clsx). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Brand mark: a teal-gradient hexagon with a white dot. */
export function Hexagon({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="flex items-center justify-center bg-gradient-to-br from-teal-600 to-teal-700 shadow-[0_4px_14px_rgba(13,148,136,.3)]"
      style={{
        width: size,
        height: size,
        clipPath:
          'polygon(25% 6.7%,75% 6.7%,100% 50%,75% 93.3%,25% 93.3%,0% 50%)',
      }}
    >
      <span
        className="rounded-full bg-white"
        style={{ width: size * 0.28, height: size * 0.28 }}
      />
    </span>
  );
}

/** White surface card with the standard border + soft shadow. */
export function Card({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-card border border-gray-200 bg-white shadow-card',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Card header row: uppercase section label on the left, actions on the right. */
export function CardHeader({
  title,
  right,
}: {
  title: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
      {typeof title === 'string' ? <SectionLabel>{title}</SectionLabel> : title}
      <div className="flex-1" />
      {right}
    </div>
  );
}

/** Uppercase tracked label (10–11px / 500). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
      {children}
    </span>
  );
}

export type Tone = 'teal' | 'green' | 'amber' | 'red' | 'gray' | 'info';

const DOT_BG: Record<Tone, string> = {
  teal: 'bg-teal-600',
  green: 'bg-green-600',
  amber: 'bg-amber-600',
  red: 'bg-red-600',
  gray: 'bg-gray-300',
  info: 'bg-cyan-600',
};

/** Status indicator — a rounded 2px SQUARE (brand cue), not a circle. */
export function StatusDot({
  tone = 'green',
  pulse = false,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-[7px] w-[7px] shrink-0 rounded-sm',
        DOT_BG[tone],
        pulse && 'animate-recpulse',
        className,
      )}
    />
  );
}

const BADGE_TONE: Record<Tone, string> = {
  teal: 'bg-teal-100 text-teal-700',
  green: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-50 text-red-700 border border-red-200',
  gray: 'bg-gray-100 text-gray-600',
  info: 'bg-cyan-100 text-cyan-700',
};

/** Small status chip. `mono` for IDs/measurements. */
export function Badge({
  tone = 'gray',
  mono = false,
  dot = false,
  children,
  className,
}: {
  tone?: Tone;
  mono?: boolean;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-xs font-semibold',
        mono && 'font-mono',
        BADGE_TONE[tone],
        className,
      )}
    >
      {dot && <StatusDot tone={tone} />}
      {children}
    </span>
  );
}

/** Teal pill primary button. */
export function Button({
  variant = 'primary',
  className,
  children,
  ...rest
}: {
  variant?: 'primary' | 'danger' | 'ghost';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles: Record<string, string> = {
    primary: 'bg-teal-600 text-white shadow-btn hover:bg-teal-700',
    danger: 'bg-red-600 text-white shadow-btn-red hover:bg-red-700',
    ghost: 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

