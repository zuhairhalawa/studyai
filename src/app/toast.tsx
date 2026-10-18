import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';

type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void;
}

const Ctx = createContext<ToastApi>({ show: () => undefined });
export const useToast = (): ToastApi => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-3), { id, kind, message }]);
      // Errors stay until dismissed; confirmations disappear.
      if (kind !== 'error') window.setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex max-w-lg items-start gap-3 rounded-[var(--radius-panel)] border border-rule-strong bg-surface px-4 py-3 text-sm text-ink shadow-lg"
          >
            {t.kind === 'error' ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />}
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button type="button" onClick={() => dismiss(t.id)} className="-m-1 rounded p-1 text-ink-3 hover:text-ink" aria-label="Dismiss notification">
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
