import { useEffect, useRef, useState } from 'react';
import { Download, HardDrive, ShieldCheck, Upload } from 'lucide-react';
import { applyBackup, BackupError, exportBackup, readBackup, type ImportMode, type ParsedBackup } from '@/core/backup/backup';
import { getDb } from '@/core/db/db';
import { useAllLectures, useCourses } from '@/app/data';
import { useTheme, type ThemeChoice } from '@/app/theme';
import { useToast } from '@/app/toast';
import { OwnerPanel } from '@/ui/ai/OwnerPanel';
import { Button, Callout, Dialog, formatBytes, Spinner } from '@/ui/primitives';

const db = getDb();

export function SettingsPage() {
  const { choice, setChoice } = useTheme();
  const courses = useCourses();
  const lectures = useAllLectures();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState<string | undefined>();
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<{ backup: ParsedBackup; name: string } | undefined>();
  const [mode, setMode] = useState<ImportMode>('merge');
  const [applying, setApplying] = useState(false);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});

  const refreshStorage = async () => {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    setStorage({ usage: est?.usage, quota: est?.quota, persisted });
  };
  useEffect(() => void refreshStorage(), [courses, lectures]);

  const doExport = async () => {
    try {
      setExporting('Starting');
      const blob = await exportBackup(db, (p) => setExporting(`${p.label} (${p.done} of ${p.total})`), 'studyai 0.1');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `studyai-backup-${new Date().toISOString().slice(0, 10)}.studyai.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.show(`Backup saved (${formatBytes(blob.size)}). Keep it somewhere safe, such as cloud storage you already use.`, 'ok');
    } catch (err) {
      toast.show(err instanceof Error ? `Backup failed: ${err.message}` : 'Backup failed.', 'error');
    } finally {
      setExporting(undefined);
    }
  };

  const choose = async (file: File) => {
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Yield once so the spinner paints before the (synchronous) validation runs.
      await new Promise((r) => setTimeout(r, 30));
      setPreview({ backup: readBackup(bytes), name: file.name });
      setMode('merge');
    } catch (err) {
      toast.show(err instanceof BackupError ? err.message : 'That file could not be read.', 'error');
    } finally {
      setReading(false);
    }
  };

  const doRestore = async () => {
    if (!preview) return;
    setApplying(true);
    try {
      const s = await applyBackup(db, preview.backup, mode);
      toast.show(`Restored: ${s.lecturesAdded + s.lecturesReplaced} lectures (${s.slides} slides), ${s.coursesAdded + s.coursesUpdated} courses${s.lecturesSkipped ? `, ${s.lecturesSkipped} unchanged` : ''}.`, 'ok');
      setPreview(undefined);
    } catch (err) {
      toast.show(err instanceof Error ? `Restore failed: ${err.message}` : 'Restore failed.', 'error');
    } finally {
      setApplying(false);
    }
  };

  const themes: [ThemeChoice, string][] = [
    ['system', 'Match my device'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];
  const slideTotal = (lectures ?? []).reduce((n, l) => n + l.slideCount, 0);
  const b = preview?.backup;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings and backup</h1>

      <section className="mt-8" aria-labelledby="appearance-h">
        <h2 id="appearance-h" className="text-lg font-semibold">
          Appearance
        </h2>
        <fieldset className="mt-3">
          <legend className="sr-only">Theme</legend>
          <div className="inline-flex overflow-hidden rounded-[var(--radius-control)] border border-rule-strong">
            {themes.map(([id, label]) => (
              <label key={id} className={`inline-flex min-h-10 cursor-pointer items-center px-3.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${choice === id ? 'bg-accent-soft font-medium text-ink' : 'bg-surface text-ink-2 hover:bg-sunken'}`}>
                <input type="radio" name="theme" value={id} checked={choice === id} onChange={() => setChoice(id)} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="mt-10" aria-labelledby="backup-h">
        <h2 id="backup-h" className="text-lg font-semibold">
          Backup and restore
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">
          Your library lives only in this browser. Clearing site data, switching browser or device, or a reinstall removes it. A backup is one file containing your courses, lectures, slides, images and the original PowerPoint files.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="primary" onClick={() => void doExport()} disabled={!!exporting || (courses?.length ?? 0) === 0}>
            <Download className="size-4" aria-hidden /> Export backup
          </Button>
          <Button onClick={() => fileInput.current?.click()} disabled={reading}>
            <Upload className="size-4" aria-hidden /> Restore from backup
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.studyai.zip,application/zip"
            className="sr-only"
            aria-label="Choose a backup file"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void choose(f);
              e.target.value = '';
            }}
          />
        </div>
        {exporting && (
          <p className="mt-3">
            <Spinner label={`Exporting: ${exporting}`} />
          </p>
        )}
        {reading && (
          <p className="mt-3">
            <Spinner label="Checking the backup" />
          </p>
        )}
      </section>

      <section className="mt-10" aria-labelledby="storage-h">
        <h2 id="storage-h" className="text-lg font-semibold">
          This device
        </h2>
        <dl className="mt-3 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule text-sm sm:grid-cols-3">
          <div className="bg-surface px-4 py-3">
            <dt className="text-[13px] text-ink-3">Courses and lectures</dt>
            <dd className="text-lg font-semibold">
              {courses?.length ?? 0} and {lectures?.length ?? 0}
            </dd>
          </div>
          <div className="bg-surface px-4 py-3">
            <dt className="text-[13px] text-ink-3">Slides stored</dt>
            <dd className="text-lg font-semibold">{slideTotal}</dd>
          </div>
          <div className="bg-surface px-4 py-3">
            <dt className="text-[13px] text-ink-3">Space used</dt>
            <dd className="text-lg font-semibold">{storage.usage !== undefined ? formatBytes(storage.usage) : 'Unknown'}</dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-ink-2">
          <HardDrive className="size-4" aria-hidden />
          {storage.persisted ? (
            <span>The browser has promised not to clear this data automatically.</span>
          ) : (
            <>
              <span>The browser may clear this data if the device runs low on space.</span>
              <Button
                size="sm"
                onClick={async () => {
                  const ok = await navigator.storage?.persist?.();
                  toast.show(ok ? 'Protected from automatic cleanup.' : 'The browser declined. Keep regular backups instead.', ok ? 'ok' : 'info');
                  void refreshStorage();
                }}
              >
                Ask the browser to keep it
              </Button>
            </>
          )}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="ai-h">
        <h2 id="ai-h" className="text-lg font-semibold">
          AI tutor (Gemini free tier)
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">
          Optional and private. Everything else in the app works without it, and keeps working if AI is switched off, paused or out of budget. AI never runs on its own: it only sends something when you press send, and it shows you exactly what first.
        </p>
        <div className="mt-4">
          <OwnerPanel />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="privacy-h">
        <h2 id="privacy-h" className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="size-5 text-ok" aria-hidden /> Privacy
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>PowerPoint files are read in your browser and are never uploaded.</li>
          <li>There is no account, no analytics and no tracking. Fonts are bundled with the app.</li>
          <li>Only a backup file you create leaves this browser.</li>
        </ul>
      </section>

      <Dialog
        open={!!preview}
        onClose={() => !applying && setPreview(undefined)}
        wide
        title="Restore from backup"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(undefined)} disabled={applying}>
              Cancel
            </Button>
            <Button variant={mode === 'replace' ? 'danger' : 'primary'} onClick={() => void doRestore()} disabled={applying}>
              {applying ? 'Restoring' : mode === 'replace' ? 'Replace my library' : 'Merge into my library'}
            </Button>
          </>
        }
      >
        {b && preview && (
          <div className="flex flex-col gap-4 text-sm">
            <p>
              <span className="font-medium">{preview.name}</span> was made {new Date(b.manifest.createdAt).toLocaleString()}. It was checked and is safe to read.
            </p>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule sm:grid-cols-4">
              {(
                [
                  ['Courses', b.manifest.counts.courses],
                  ['Lectures', b.manifest.counts.lectures],
                  ['Slides', b.manifest.counts.slides],
                  ['Images', b.manifest.counts.media],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="bg-surface px-3 py-2">
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            {b.warnings.length > 0 && (
              <Callout tone="warn" title="Notes about this backup">
                <ul className="list-disc space-y-0.5 pl-4">
                  {b.warnings.slice(0, 6).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="font-medium">How should it be restored?</legend>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border border-rule p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} className="mt-1 accent-[var(--accent)]" />
                <span>
                  <span className="block font-medium">Merge (recommended)</span>
                  <span className="text-ink-2">Adds what is missing and updates lectures that are newer in the backup. Nothing is deleted.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border border-rule p-3 has-[:checked]:border-bad has-[:checked]:bg-bad-soft">
                <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} className="mt-1 accent-[var(--bad)]" />
                <span>
                  <span className="block font-medium">Replace everything</span>
                  <span className="text-ink-2">Deletes your current library on this device first, then restores the backup. Export a backup before choosing this.</span>
                </span>
              </label>
            </fieldset>
          </div>
        )}
      </Dialog>
    </div>
  );
}
