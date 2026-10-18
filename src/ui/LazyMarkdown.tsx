import { lazy, Suspense } from 'react';

const Md = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

/** Markdown with KaTeX and code highlighting, loaded on demand (it is the heaviest part of the app). */
export function LazyMarkdown({ children, className, inline = false }: { children: string; className?: string; inline?: boolean }) {
  return (
    <Suspense fallback={inline ? <span className={className}>{children}</span> : <div className={`md whitespace-pre-wrap ${className ?? ''}`}>{children}</div>}>
      <Md className={className} inline={inline}>{children}</Md>
    </Suspense>
  );
}
