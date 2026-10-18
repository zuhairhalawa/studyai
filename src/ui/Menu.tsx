import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, EllipsisVertical } from 'lucide-react';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** Small action menu: button + popover list with Escape, outside-click and arrow-key support. */
export function Menu({ label, items, text, icon }: { label: string; items: MenuItem[]; /** When given, the trigger is a labelled button instead of a kebab icon. */ text?: string; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      root.current?.querySelector('button')?.focus();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [])];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  return (
    <div className="relative" ref={root} onKeyDown={onKey}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className={
          text
            ? 'inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-rule-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-sunken'
            : 'inline-flex size-10 items-center justify-center rounded-[var(--radius-control)] text-ink-2 hover:bg-sunken hover:text-ink'
        }
      >
        {text ? (
          <>
            {icon}
            {text}
            <ChevronDown className="size-4 text-ink-3" aria-hidden />
          </>
        ) : (
          <EllipsisVertical className="size-4" aria-hidden />
        )}
      </button>
      {open && (
        <ul id={id} role="menu" className="absolute right-0 z-20 mt-1 min-w-48 rounded-[var(--radius-panel)] border border-rule-strong bg-surface p-1 shadow-lg">
          {items.map((it) => (
            <li key={it.label} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={`flex min-h-10 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-left text-sm disabled:opacity-40 ${it.danger ? 'text-bad hover:bg-bad-soft' : 'text-ink hover:bg-sunken'}`}
              >
                {it.icon}
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
