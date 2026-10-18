import { createContext, Suspense, useContext, useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BookOpen, Menu, Monitor, Moon, Plus, Search, Settings, Sun, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { createCourse } from '@/core/db/library';
import { Button, Dialog, Field, IconButton, TextInput } from '@/ui/primitives';
import { useAllLectures, useCourses } from './data';
import { useTheme } from './theme';
import { useToast } from './toast';

const db = getDb();

export const COURSE_COLORS = ['#0b6e6e', '#2b5fa6', '#7a3e9d', '#b4531f', '#8a6d00', '#a6325d', '#3f7a2a', '#556270'];

interface ShellApi {
  openNewCourse: () => void;
}
const ShellCtx = createContext<ShellApi>({ openNewCourse: () => undefined });
export const useShell = (): ShellApi => useContext(ShellCtx);

export function Shell() {
  const courses = useCourses();
  const lectures = useAllLectures();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { choice, setChoice } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newCourse, setNewCourse] = useState(false);
  const [q, setQ] = useState('');

  // Close the mobile menu on navigation.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const counts = new Map<string, number>();
  for (const l of lectures ?? []) counts.set(l.courseId, (counts.get(l.courseId) ?? 0) + 1);
  const active = (courses ?? []).filter((c) => !c.archived);
  const archived = (courses ?? []).filter((c) => c.archived);

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(`/search?q=${encodeURIComponent(term)}`);
  };

  const nextTheme = () => setChoice(choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system');
  const ThemeIcon = choice === 'system' ? Monitor : choice === 'light' ? Sun : Moon;

  const link = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-sm ${isActive ? 'bg-accent-soft font-medium text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink'}`;

  const sidebar = (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <div className="flex items-center justify-between px-1.5 pt-1">
        <NavLink to="/" className="text-[17px] font-semibold tracking-tight text-ink" aria-label="StudyAI home">
          Study<span className="text-accent">AI</span>
        </NavLink>
        <IconButton label="Close menu" onClick={() => setMenuOpen(false)} className="md:hidden">
          <X className="size-5" aria-hidden />
        </IconButton>
      </div>

      {/* The sidebar is rendered twice (desktop + mobile drawer): use an implicit label, never a shared id. */}
      <form onSubmit={submitSearch} role="search">
        <label className="relative block">
          <span className="sr-only">Search all lectures</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lectures" className="pl-8" />
        </label>
      </form>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        <NavLink to="/" end className={link}>
          <BookOpen className="size-4" aria-hidden /> Dashboard
        </NavLink>
        <NavLink to="/settings" className={link}>
          <Settings className="size-4" aria-hidden /> Settings and backup
        </NavLink>
      </nav>

      <nav aria-label="Courses" className="flex min-h-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between px-2.5">
          <h2 className="text-[13px] font-semibold text-ink-2">Courses</h2>
          <IconButton label="New course" onClick={() => setNewCourse(true)} className="-mr-2 size-8">
            <Plus className="size-4" aria-hidden />
          </IconButton>
        </div>
        {courses === undefined ? null : active.length === 0 ? (
          <p className="px-2.5 text-[13px] text-ink-3">No courses yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {active.map((c) => (
              <li key={c.id}>
                <NavLink to={`/course/${c.id}`} className={link}>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: COURSE_COLORS[c.color % COURSE_COLORS.length] }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="text-xs text-ink-3" aria-label={`${counts.get(c.id) ?? 0} lectures`}>
                    {counts.get(c.id) ?? 0}
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
        {archived.length > 0 && (
          <details className="mt-2 px-1">
            <summary className="cursor-pointer px-1.5 py-1 text-[13px] text-ink-3">Archived ({archived.length})</summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {archived.map((c) => (
                <li key={c.id}>
                  <NavLink to={`/course/${c.id}`} className={link}>
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </details>
        )}
      </nav>

      <div className="flex items-center justify-between border-t border-rule px-1 pt-3">
        <p className="text-xs text-ink-3">Stored on this device only</p>
        <IconButton label={`Theme: ${choice}. Click to change.`} onClick={nextTheme} className="-mr-2 size-9">
          <ThemeIcon className="size-4" aria-hidden />
        </IconButton>
      </div>
    </div>
  );

  return (
    <ShellCtx.Provider value={{ openNewCourse: () => setNewCourse(true) }}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">
        Skip to content
      </a>
      <div className="min-h-dvh md:grid md:grid-cols-[264px_minmax(0,1fr)] print:block">
        <aside className="sticky top-0 hidden h-dvh border-r border-rule bg-surface md:block print:hidden" aria-label="Sidebar">
          {sidebar}
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-rule bg-surface px-3 py-2 md:hidden print:hidden">
            <IconButton label="Open menu" onClick={() => setMenuOpen(true)}>
              <Menu className="size-5" aria-hidden />
            </IconButton>
            <NavLink to="/" className="text-[17px] font-semibold tracking-tight">
              Study<span className="text-accent">AI</span>
            </NavLink>
          </header>
          <main id="main" className="min-w-0">
            <Suspense fallback={<div className="p-6 text-sm text-ink-2" role="status">Loading…</div>}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 bg-[var(--scrim)]" onClick={() => setMenuOpen(false)} aria-label="Close menu" tabIndex={-1} />
          <div className="relative h-full w-[min(20rem,86vw)] bg-surface shadow-xl">{sidebar}</div>
        </div>
      )}

      <NewCourseDialog
        open={newCourse}
        onClose={() => setNewCourse(false)}
        onCreate={async (name, code) => {
          try {
            const c = await createCourse(db, { name, code });
            setNewCourse(false);
            navigate(`/course/${c.id}`);
          } catch (err) {
            toast.show(err instanceof Error ? err.message : 'Could not create the course.', 'error');
          }
        }}
      />
    </ShellCtx.Provider>
  );
}

function NewCourseDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (name: string, code?: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setCode('');
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New course"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-course-form" disabled={!name.trim() || busy}>
            Create course
          </Button>
        </>
      }
    >
      <form
        id="new-course-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          void onCreate(name, code || undefined).finally(() => setBusy(false));
        }}
      >
        <Field label="Course name" htmlFor="course-name">
          <TextInput id="course-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Computability and Complexity" autoFocus />
        </Field>
        <Field label="Course code (optional)" htmlFor="course-code">
          <TextInput id="course-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="BCS303" />
        </Field>
      </form>
    </Dialog>
  );
}
