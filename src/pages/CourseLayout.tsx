import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { Settings2, Sparkles, Trash2, Upload } from 'lucide-react';
import { getDb, type CourseRow, type LectureRow } from '@/core/db/db';
import { deleteCourse, updateCourse } from '@/core/db/library';
import { useCards, useCourse, useLectures } from '@/app/data';
import { COURSE_COLORS } from '@/app/Shell';
import { useToast } from '@/app/toast';
import { Menu } from '@/ui/Menu';
import type { PlannedSlot } from '@/core/study/blueprint';
import { GenerateDialog } from '@/ui/ai/GenerateDialog';
import { AiExportDialog, PackImportDialog } from '@/ui/study/PackDialogs';
import { Button, Dialog, Field, Spinner, TextArea, TextInput } from '@/ui/primitives';
import { NotFound } from './NotFound';

const db = getDb();

export interface CourseCtx {
  course: CourseRow;
  lectures: LectureRow[];
}

export function daysUntil(isoDate: string | undefined): number | undefined {
  if (!isoDate) return undefined;
  const t = new Date(`${isoDate}T00:00:00`).getTime();
  if (Number.isNaN(t)) return undefined;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((t - today.getTime()) / 86_400_000);
}

export function examLabel(isoDate: string | undefined): string | undefined {
  const d = daysUntil(isoDate);
  if (d === undefined) return undefined;
  if (d < 0) return `Exam was ${-d} day${d === -1 ? '' : 's'} ago`;
  if (d === 0) return 'Exam is today';
  return `Exam in ${d} day${d === 1 ? '' : 's'}`;
}

export function CourseLayout() {
  const { courseId } = useParams();
  const course = useCourse(courseId);
  const lectures = useLectures(courseId);
  const cards = useCards(courseId);
  const navigate = useNavigate();
  const [details, setDetails] = useState(false);
  const [aiExport, setAiExport] = useState(false);
  const [packImport, setPackImport] = useState(false);
  const [generate, setGenerate] = useState(false);
  const [generated, setGenerated] = useState<string | undefined>();
  const [generatedCutOff, setGeneratedCutOff] = useState(false);
  /** The questions that were asked for, so the import check can compare what came back with the plan. */
  const [generatedPlan, setGeneratedPlan] = useState<PlannedSlot[] | undefined>();

  if (course === null) return <NotFound what="course" />;
  if (course === undefined || lectures === undefined) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  const totalSlides = lectures.reduce((n, l) => n + l.slideCount, 0);
  const exam = examLabel(course.examDate);
  const now = Date.now();
  const due = (cards ?? []).filter((c) => c.status === 'approved' && c.fsrs.state !== 0 && c.fsrs.due <= now).length;
  const pending = (cards ?? []).filter((c) => c.status === 'pending').length;

  const tab = ({ isActive }: { isActive: boolean }) =>
    `-mb-px inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium ${isActive ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink'}`;
  const badge = (n: number, label: string, tone: 'accent' | 'warn' = 'accent') =>
    n > 0 ? (
      <span className={`rounded-full px-1.5 py-0.5 text-xs ${tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-ink'}`} aria-label={`${n} ${label}`}>
        {n}
      </span>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-l-4 pl-4 print:hidden" style={{ borderColor: COURSE_COLORS[course.color % COURSE_COLORS.length] }}>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{course.name}</h1>
          <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
            {course.code && (
              <div>
                <dt className="sr-only">Course code</dt>
                <dd className="font-mono text-[13px]">{course.code}</dd>
              </div>
            )}
            <div>
              <dt className="sr-only">Lectures</dt>
              <dd>
                {lectures.length} lecture{lectures.length === 1 ? '' : 's'}
              </dd>
            </div>
            <div>
              <dt className="sr-only">Slides</dt>
              <dd>{totalSlides} slides</dd>
            </div>
            {exam && (
              <div>
                <dt className="sr-only">Exam</dt>
                <dd className="font-medium text-ink">{exam}</dd>
              </div>
            )}
            {course.archived && <div className="font-medium text-warn">Archived</div>}
          </dl>
        </div>
        <div className="flex items-center gap-2">
          <Menu
            label="Study packs from your own AI"
            text="Study packs"
            icon={<Sparkles className="size-4" aria-hidden />}
            items={[
              { label: 'Generate with the AI tutor (Gemini)…', icon: <Sparkles className="size-4" aria-hidden />, onSelect: () => setGenerate(true), disabled: lectures.length === 0 },
              { label: 'Create a pack with your own AI…', icon: <Sparkles className="size-4" aria-hidden />, onSelect: () => setAiExport(true), disabled: lectures.length === 0 },
              { label: 'Import a study pack…', icon: <Upload className="size-4" aria-hidden />, onSelect: () => setPackImport(true), disabled: lectures.length === 0 },
            ]}
          />
          <Button variant="secondary" onClick={() => setDetails(true)}>
            <Settings2 className="size-4" aria-hidden /> Course details
          </Button>
        </div>
      </header>

      <nav aria-label="Course sections" className="mt-5 flex overflow-x-auto border-b border-rule print:hidden">
        <NavLink to={`/course/${course.id}`} end className={tab}>
          Lectures
        </NavLink>
        <NavLink to={`/course/${course.id}/cards`} className={tab}>
          Flashcards {badge(due, 'due now')} {badge(pending, 'to review', 'warn')}
        </NavLink>
        <NavLink to={`/course/${course.id}/notes`} className={tab}>
          Notes
        </NavLink>
        <NavLink to={`/course/${course.id}/practice`} className={tab}>
          Practice and exams
        </NavLink>
        <NavLink to={`/course/${course.id}/tutor`} className={tab}>
          AI tutor
        </NavLink>
      </nav>

      <div className="pt-6">
        <Outlet context={{ course, lectures } satisfies CourseCtx} />
      </div>

      <CourseDetailsDialog
        open={details}
        course={course}
        onClose={() => setDetails(false)}
        onDeleted={() => {
          setDetails(false);
          navigate('/');
        }}
      />
      <AiExportDialog open={aiExport} onClose={() => setAiExport(false)} course={course} lectures={lectures} />
      <GenerateDialog
        open={generate}
        onClose={() => setGenerate(false)}
        course={course}
        lectures={lectures}
        onGenerated={(json, cutOff, expected) => {
          setGenerated(json);
          setGeneratedCutOff(cutOff);
          setGeneratedPlan(expected);
          setPackImport(true);
        }}
      />
      <PackImportDialog
        open={packImport}
        onClose={() => {
          setPackImport(false);
          setGenerated(undefined);
          setGeneratedCutOff(false);
          setGeneratedPlan(undefined);
        }}
        course={course}
        lectures={lectures}
        {...(generated ? { initialText: generated, cutOff: generatedCutOff, ...(generatedPlan ? { expected: generatedPlan } : {}) } : {})}
      />
    </div>
  );
}

function CourseDetailsDialog({ open, course, onClose, onDeleted }: { open: boolean; course: CourseRow; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(course.name);
  const [code, setCode] = useState(course.code ?? '');
  const [examDate, setExamDate] = useState(course.examDate ?? '');
  const [goal, setGoal] = useState(course.goal ?? '');
  const [style, setStyle] = useState(course.examStyle ?? '');
  const [confirmDelete, setConfirmDelete] = useState('');
  const [seen, setSeen] = useState(false);

  if (open && !seen) {
    setSeen(true);
    setName(course.name);
    setCode(course.code ?? '');
    setExamDate(course.examDate ?? '');
    setGoal(course.goal ?? '');
    setStyle(course.examStyle ?? '');
    setConfirmDelete('');
  }
  if (!open && seen) setSeen(false);

  const save = async () => {
    if (!name.trim()) return;
    await updateCourse(db, course.id, {
      name: name.trim(),
      code: code.trim() || undefined,
      examDate: examDate || undefined,
      goal: goal.trim() || undefined,
      examStyle: style.trim() || undefined,
    });
    toast.show('Course details saved.', 'ok');
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Course details"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>
            Save details
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Course name" htmlFor="cd-name">
            <TextInput id="cd-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Course code" htmlFor="cd-code">
            <TextInput id="cd-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        </div>
        <Field label="Exam date" htmlFor="cd-exam" hint="Used for countdowns and study planning.">
          <TextInput id="cd-exam" type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} className="sm:max-w-56" />
        </Field>
        <Field label="Your goal" htmlFor="cd-goal" hint="For example: “Pass with at least 70%” or “Understand reductions properly”.">
          <TextInput id="cd-goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <Field
          label="Professor’s exam instructions"
          htmlFor="cd-style"
          hint="Used later when practice questions and answers are generated for this course. Example: “Most questions are scenarios and answers are 1–3 sentences. Answers must come strictly from the slides.”"
        >
          <TextArea id="cd-style" value={style} onChange={(e) => setStyle(e.target.value)} rows={4} />
        </Field>

        <div className="rounded-[var(--radius-panel)] border border-rule p-4">
          <h3 className="text-sm font-semibold">Archive or delete</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={async () => {
                await updateCourse(db, course.id, { archived: !course.archived });
                toast.show(course.archived ? 'Course restored.' : 'Course archived.', 'ok');
                onClose();
              }}
            >
              {course.archived ? 'Restore course' : 'Archive course'}
            </Button>
          </div>
          <p className="mt-3 text-[13px] text-ink-2">
            To delete this course and all of its lectures from this device, type its name (<span className="font-medium">{course.name}</span>) below.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <TextInput aria-label="Type the course name to confirm deletion" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} className="sm:max-w-64" />
            <Button
              variant="danger"
              disabled={confirmDelete.trim() !== course.name}
              onClick={async () => {
                await deleteCourse(db, course.id);
                toast.show('Course deleted.', 'ok');
                onDeleted();
              }}
            >
              <Trash2 className="size-4" aria-hidden /> Delete course
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
