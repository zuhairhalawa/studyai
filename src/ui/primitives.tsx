import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import type { Confidence, Severity } from '@/core/pptx/model';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 border border-transparent',
  secondary: 'bg-surface text-ink border border-rule-strong hover:bg-sunken',
  ghost: 'bg-transparent text-ink-2 border border-transparent hover:bg-sunken hover:text-ink',
  danger: 'bg-surface text-bad border border-bad/50 hover:bg-bad-soft',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', className = '', type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        size === 'sm' ? 'min-h-8 px-2.5 text-[13px]' : 'min-h-10 px-3.5 text-sm'
      } ${VARIANT[variant]} ${className}`}
      {...rest}
    />
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton({ label, className = '', type = 'button', children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-ink-2 transition-colors hover:bg-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const CONTROL =
  'w-full rounded-[var(--radius-control)] border border-rule-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-accent';

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-[13px] text-ink-3">{hint}</p>}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className = '', ...rest }, ref) {
  return <input ref={ref} className={`${CONTROL} min-h-10 ${className}`} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className = '', ...rest }, ref) {
  return <textarea ref={ref} className={`${CONTROL} min-h-24 py-2 leading-relaxed ${className}`} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className = '', ...rest }, ref) {
  return <select ref={ref} className={`${CONTROL} min-h-10 ${className}`} {...rest} />;
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const CONF: Record<Confidence, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  high: { label: 'Reliable', cls: 'bg-ok-soft text-ok', Icon: CheckCircle2 },
  medium: { label: 'Check', cls: 'bg-warn-soft text-warn', Icon: TriangleAlert },
  low: { label: 'Needs attention', cls: 'bg-bad-soft text-bad', Icon: CircleAlert },
};

/** Extraction confidence. Never colour-only: icon + word. */
export function ConfidencePill({ value, compact = false }: { value: Confidence; compact?: boolean }) {
  const { label, cls, Icon } = CONF[value];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`} title={`Extraction confidence: ${label}`}>
      <Icon className="size-3.5" aria-hidden />
      <span className={compact ? 'sr-only' : ''}>{label}</span>
    </span>
  );
}

const SEV: Record<Severity, { cls: string; Icon: typeof Info; label: string }> = {
  info: { cls: 'text-info', Icon: Info, label: 'Note' },
  warning: { cls: 'text-warn', Icon: TriangleAlert, label: 'Check' },
  attention: { cls: 'text-bad', Icon: CircleAlert, label: 'Needs attention' },
};

export function SeverityIcon({ severity }: { severity: Severity }) {
  const { cls, Icon, label } = SEV[severity];
  return (
    <span className={`inline-flex ${cls}`} role="img" aria-label={label}>
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

export function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; title?: string; children: ReactNode }) {
  const t = { info: 'bg-sunken border-rule', warn: 'bg-warn-soft border-warn/40', bad: 'bg-bad-soft border-bad/40', ok: 'bg-ok-soft border-ok/40' }[tone];
  return (
    <div className={`rounded-[var(--radius-panel)] border p-4 text-sm ${t}`} role={tone === 'bad' ? 'alert' : undefined}>
      {title && <p className="mb-1 font-semibold text-ink">{title}</p>}
      <div className="text-ink-2">{children}</div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-dashed border-rule-strong px-6 py-10 text-center">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children && <p className="mx-auto mt-1.5 max-w-prose text-sm text-ink-2">{children}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog (native <dialog>: focus trap, Escape and inert background for free)
// ---------------------------------------------------------------------------

export function Dialog({ open, onClose, title, children, footer, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // React's autoFocus runs before a native <dialog> is shown, so focus the first field explicitly.
      el.querySelector<HTMLElement>('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, select')?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} overflow-hidden rounded-[var(--radius-panel)] border border-rule-strong bg-surface p-0 shadow-xl`}
    >
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-rule px-5 py-3.5">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose} className="-mr-2">
              <X className="size-4" aria-hidden />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-rule px-5 py-3.5">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-ink-2">
      <span className="size-4 animate-spin rounded-full border-2 border-rule-strong border-t-accent" aria-hidden />
      {label}
    </span>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
