// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Shared visual primitives for the "Neutral Teal" design language (handoff).
// These are presentation-only: no data, no app state. Feature tabs compose
// them so cards, chips, status dots and toggles stay pixel-consistent.

import {
  cloneElement,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

/** Tiny class-name joiner (no dependency on clsx). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Brand mark: a teal-gradient hexagon with a white dot. */
export function Hexagon({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="flex items-center justify-center bg-gradient-to-br from-accent to-accent-strong shadow-btn"
      style={{
        width: size,
        height: size,
        clipPath: 'polygon(25% 6.7%,75% 6.7%,100% 50%,75% 93.3%,25% 93.3%,0% 50%)',
      }}
    >
      <span
        className="rounded-full bg-surface"
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
        'rounded-card border border-border bg-surface shadow-card',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Card header row: uppercase section label on the left, actions on the right. */
export function CardHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-4">
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
    <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
      {children}
    </h2>
  );
}

export type Tone = 'teal' | 'green' | 'amber' | 'red' | 'gray' | 'info';

const DOT_BG: Record<Tone, string> = {
  teal: 'bg-status-live-accent',
  green: 'bg-status-success-accent',
  amber: 'bg-status-warning-accent',
  red: 'bg-status-danger-accent',
  gray: 'bg-text-disabled',
  info: 'bg-status-info-accent',
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
  teal: 'bg-status-adopted-bg text-status-adopted-text',
  green: 'bg-status-success-bg text-status-success-text',
  amber: 'bg-status-warning-bg text-status-warning-text',
  red: 'border border-status-danger-border bg-status-danger-bg text-status-danger-text',
  gray: 'bg-surface-muted text-text-secondary',
  info: 'bg-status-info-bg text-status-info-text',
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
  size = 'md',
  className,
  children,
  type,
  ...rest
}: {
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: 'bg-accent text-text-inverse shadow-btn hover:bg-accent-strong',
    danger:
      'bg-status-danger-accent text-status-danger-contrast shadow-btn-red hover:bg-status-danger-text',
    ghost:
      'border border-border bg-surface text-text-secondary hover:bg-interaction-hover',
  } satisfies Record<'primary' | 'danger' | 'ghost', string>;
  const sizes = {
    sm: 'min-h-8 px-3 py-1 text-xs',
    md: 'min-h-11 px-4 py-2 text-sm',
    lg: 'min-h-11 px-5 py-2.5 text-sm',
  } satisfies Record<'sm' | 'md' | 'lg', string>;
  return (
    <button
      type={type ?? 'button'}
      className={cn(
        'inline-flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-control font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** An icon-only action with a mandatory accessible name and a 44px target by
 * default. Use `size="sm"` only where the surrounding compact control already
 * provides the documented operational density. */
export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  className,
  children,
  type,
  ...rest
}: {
  /** Localized action name announced to assistive technology. */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'danger';
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & {
    children: ReactNode;
  }) {
  const sizes = {
    sm: 'min-h-8 min-w-8 p-1.5',
    md: 'min-h-11 min-w-11 p-2.5',
  } satisfies Record<'sm' | 'md', string>;
  const styles = {
    ghost: 'text-text-muted hover:bg-interaction-hover hover:text-text-primary',
    danger:
      'text-status-danger-text hover:bg-status-danger-bg hover:text-status-danger-text',
  } satisfies Record<'ghost' | 'danger', string>;
  return (
    <button
      type={type ?? 'button'}
      aria-label={label}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center rounded-control transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app disabled:cursor-not-allowed disabled:opacity-50',
        sizes[size],
        styles[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

const NOTICE_TONE = {
  info: 'border-border bg-surface-muted text-text-secondary',
  success: 'border-accent bg-interaction-selected text-accent',
  warning: 'border-status-warning-border bg-status-warning-bg text-status-warning-text',
  danger: 'border-status-danger-border bg-status-danger-bg text-status-danger-text',
} satisfies Record<NoticeTone, string>;

/** A persistent explanatory panel, not a transient toast. Content remains a
 * ReactNode so a feature can supply localized copy, links, and recovery
 * controls without the primitive inventing operator-facing language. */
export function Notice({
  tone = 'info',
  live,
  className,
  children,
  ...rest
}: {
  tone?: NoticeTone;
  /** Announce a newly mounted, time-sensitive notice. Omit for static context. */
  live?: 'polite' | 'assertive';
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'aria-live' | 'children' | 'role'>) {
  return (
    <div
      role={live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined}
      className={cn(
        'min-w-0 rounded-control border px-3 py-2 text-sm leading-relaxed',
        NOTICE_TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A labelled single native control. `Field` supplies the programmatic name
 * and wires help/error text to that exact control; groups use `FieldGroup`.
 * The feature still owns validation and its domain-specific input. */
export function Field({
  id,
  label,
  help,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactElement<{
    id?: string;
    'aria-describedby'?: string;
    'aria-errormessage'?: string;
    'aria-invalid'?: boolean | 'true' | 'false';
  }>;
}) {
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [
    children.props['aria-describedby'],
    help ? helpId : null,
    error ? errorId : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-text-primary">
        {label}
      </label>
      {cloneElement(children, {
        id,
        'aria-describedby': describedBy || undefined,
        'aria-errormessage': error ? errorId : undefined,
        'aria-invalid': error ? true : children.props['aria-invalid'],
      })}
      {help && (
        <p id={helpId} className="text-xs leading-relaxed text-text-muted">
          {help}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-xs leading-relaxed text-status-danger-text"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/** A labelled group of related controls. Unlike `Field`, it intentionally
 * names the group rather than pretending to label every child control. */
export function FieldGroup({
  id,
  label,
  help,
  error,
  className,
  children,
}: {
  /** Stable DOM prefix that links group-level help and error text. */
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <fieldset
      aria-describedby={describedBy || undefined}
      aria-errormessage={error ? errorId : undefined}
      aria-invalid={error ? true : undefined}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      <legend className="text-sm font-medium text-text-primary">{label}</legend>
      {children}
      {help && (
        <p id={helpId} className="text-xs leading-relaxed text-text-muted">
          {help}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-xs leading-relaxed text-status-danger-text"
        >
          {error}
        </p>
      )}
    </fieldset>
  );
}

const CONTROL_CLASS =
  'min-w-0 rounded-control border border-border bg-surface-control px-2.5 py-1.5 text-sm text-text-primary transition-colors placeholder:text-text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:border-border-disabled disabled:bg-interaction-disabled disabled:text-text-disabled disabled:opacity-100';

/** Native controls keep their native semantics while centralising theme,
 * focus, disabled, and content-driven sizing behaviour. */
export function TextInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL_CLASS, className)} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL_CLASS, className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL_CLASS, className)} {...rest} />;
}

/** A thin Settings card composition. It standardises only the repeated section
 * heading/help/action structure; its children retain the section's domain
 * workflow and layout. */
export function SettingsSection({
  title,
  description,
  actions,
  className,
  children,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <Card className={cn('flex min-w-0 flex-col overflow-auto', className)} {...rest}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-border px-4 py-[13px]">
        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {title}
          </h2>
          {description && (
            <div className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {description}
            </div>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </Card>
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
  return Array.from(nodes).filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0,
  );
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
      <div aria-hidden className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md rounded-card border border-border bg-surface-elevated p-5 shadow-float focus:outline-none"
      >
        {title && (
          <h2 className="mb-2 text-[15px] font-semibold text-text-primary">{title}</h2>
        )}
        {children && <div className="text-sm text-text-secondary">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
