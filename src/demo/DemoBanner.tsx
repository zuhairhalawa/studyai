import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Info } from 'lucide-react';
import { useCourses, useSetting } from '@/app/data';
import { useToast } from '@/app/toast';
import { getDb } from '@/core/db/db';
import { Button } from '@/ui/primitives';
import { SAMPLE_COURSE_SETTING } from './setting';

const db = getDb();

/**
 * Shown on every page of the static public demo (never in the regular app). It says, in plain words, what a visitor needs to
 * know before trying it, and offers the one-click sample course. The lecture builder and the sample material are loaded only
 * when the button is pressed.
 */
export function DemoBanner() {
  const navigate = useNavigate();
  const toast = useToast();
  const courses = useCourses();
  const [sampleId] = useSetting<string>(SAMPLE_COURSE_SETTING);
  const [busy, setBusy] = useState(false);
  const have = !!sampleId && (courses ?? []).some((c) => c.id === sampleId);

  const load = async () => {
    setBusy(true);
    try {
      const { loadSampleCourse } = await import('./sample-course');
      const { courseId, created } = await loadSampleCourse(db);
      if (created) toast.show('The sample course is ready. Its lectures and questions are invented.', 'ok');
      navigate(`/course/${courseId}`);
    } catch (err) {
      toast.show(err instanceof Error ? `The sample course could not be loaded: ${err.message}` : 'The sample course could not be loaded.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="About this demo" className="border-b border-rule bg-accent-soft text-ink print:hidden">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 text-sm md:px-8">
        <p className="min-w-0 flex-1 basis-72">
          <Info className="mr-1.5 inline size-4 align-text-bottom" aria-hidden />
          <strong className="font-semibold">Demo.</strong> The sample content is fictional. Anything you add stays in this browser and is never uploaded. AI features are not available in the demo.{' '}
          <a className="font-medium underline underline-offset-2" href="https://github.com/zuhairhalawa/studyai" target="_blank" rel="noopener noreferrer">
            Get the app
          </a>
        </p>
        <Button variant="primary" size="sm" onClick={() => void load()} disabled={busy}>
          {busy ? 'Loading the sample course…' : have ? 'Open the sample course' : 'Load the sample course'}
        </Button>
      </div>
    </section>
  );
}
