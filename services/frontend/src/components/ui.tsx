// Shared visual primitives for the "Neutral Teal" design language (handoff).
// These are presentation-only: no data, no app state. Feature tabs compose
// them so cards, chips, status dots and toggles stay pixel-consistent.

import { useEffect, useRef, type ReactNode } from 'react';

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

/** Uppercase tracked label (10–11px / 500).
 *
 *  An `h2` because every caller uses it to title a card or panel, which is the
 *  level below each screen's own `h1` — this is where a screen reader's heading
 *  list gets its entries. Tailwind's preflight zeroes heading margins and
 *  inherits their font-size, so the tag carries no styling of its own; the
 *  classes below remain the whole appearance. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
      {children}
    </h2>
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
  ...rest
}: {
  tone?: Tone;
  mono?: boolean;
  dot?: boolean;
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-xs font-semibold',
        mono && 'font-mono',
        BADGE_TONE[tone],
        className,
      )}
      {...rest}
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

/** Inline trash-can icon — the project ships no icon library, so it's a
 *  hand-drawn SVG that inherits `currentColor` and sizes from the caller. */
export function TrashIcon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/**
 * Every tab stop inside *root*, in document order.
 *
 * Deliberately NOT filtered on visibility: jsdom cannot measure layout, so an
 * `offsetParent` check would be untestable here and would quietly do nothing.
 * The dialog renders its own children and hides none of them, so the list is
 * the children. `tabIndex >= 0` drops the dialog container itself, which is
 * focusable (`tabIndex={-1}`) precisely so that it is NOT a tab stop.
 */
function tabStopsWithin(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    'a[href], button, input, textarea, select, [tabindex]',
  );
  return Array.from(nodes).filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0);
}

/**
 * Lightweight modal/dialog. No portal: the SPA has a single root and the overlay
 * is `fixed` at a high z-index, so the DOM position of this element is
 * irrelevant. ESC and a backdrop click both call `onClose`; `footer` holds the
 * action buttons (render the destructive one as a `danger` Button).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreToRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Tab containment (E-31's deferred half). Escape has always worked, so
      // this was never a trap in the sense of being stuck — it was Tab walking
      // out of the dialog and into the page BEHIND the overlay, where the
      // cursor is invisible and the controls are the ones the dialog covers.
      //
      // Only the two wrap points are taken. In the middle the browser's own tab
      // order is already correct, and cancelling those keystrokes would replace
      // a leak with a hijack.
      const node = dialogRef.current;
      if (!node) return;
      const stops = tabStopsWithin(node);
      if (stops.length === 0) {
        // Nothing to tab to. Keeping the cursor on the dialog is the whole
        // point: the alternative is the page behind the overlay.
        e.preventDefault();
        node.focus();
        return;
      }
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;
      if (!node.contains(active)) {
        // The cursor is outside — the dialog just opened onto a page whose
        // focus it did not take, or a click landed on the backdrop. Bring it in
        // at the end Tab was heading for.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus: into the dialog on open, back out on close. Without this a keyboard
  // operator lost their cursor to <body> the moment a dialog opened — Tab then
  // restarts at the top of the document, behind the overlay. (Escape has always
  // worked, so this was never a trap; it was a dialog you could not type into.)
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    restoreToRef.current =
      previous instanceof HTMLElement && previous !== document.body ? previous : null;

    // Deferential: a child that manages its own focus (an `autoFocus` field —
    // several dialogs have one) has already claimed it, because child effects
    // run before this parent one. Taking it away would move the cursor off the
    // very field the dialog exists to have typed into.
    const node = dialogRef.current;
    if (node && !node.contains(document.activeElement)) node.focus();

    return () => {
      const target = restoreToRef.current;
      restoreToRef.current = null;
      if (target?.isConnected) {
        target.focus();
        return;
      }
      // The trigger is GONE — the common case, and the one that made this bug:
      // a menu item unmounts as the dialog it opened appears. Restoring to a
      // detached node is a silent no-op that looks like a fix, and guessing
      // another control could put the cursor on a destructive one. The page
      // landmark actions nothing, keeps a cursor in the document, and lets Tab
      // resume in document order.
      const main = document.querySelector('main');
      if (main instanceof HTMLElement) {
        // `main` is not ours, so the tabindex that makes it focusable is put on
        // only for this call and taken straight off again — leaving it behind
        // would permanently insert a node into nobody's tab order but its own.
        const had = main.hasAttribute('tabindex');
        if (!had) main.setAttribute('tabindex', '-1');
        main.focus();
        if (!had) main.removeAttribute('tabindex');
      }
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden className="absolute inset-0 bg-gray-900/30" onClick={onClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md rounded-card border border-gray-200 bg-white p-5 shadow-float focus:outline-none"
      >
        {title && <h2 className="mb-2 text-[15px] font-semibold text-gray-900">{title}</h2>}
        {children && <div className="text-sm text-gray-600">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

