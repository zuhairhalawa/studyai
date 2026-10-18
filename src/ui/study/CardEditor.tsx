import { useEffect, useState } from 'react';
import { getDb, type LectureRow } from '@/core/db/db';
import { createCard, updateCard } from '@/core/study/store';
import { BASES, BASIS_LABEL, CARD_TYPES, CARD_TYPE_LABEL, type Basis, type CardRow, type CardType } from '@/core/study/types';
import { useToast } from '@/app/toast';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { Button, Dialog, Field, Select, TextArea, TextInput } from '@/ui/primitives';
import { SourceList } from './Sources';

const db = getDb();

/** Create or edit one card, with a live preview of how it will look (markdown, maths, code). */
export function CardEditor({ open, onClose, courseId, lectures, card }: { open: boolean; onClose: () => void; courseId: string; lectures: LectureRow[]; card?: CardRow }) {
  const toast = useToast();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [type, setType] = useState<CardType>('qa');
  const [basis, setBasis] = useState<Basis>('uncertain');
  const [tags, setTags] = useState('');
  const [lectureId, setLectureId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFront(card?.front ?? '');
    setBack(card?.back ?? '');
    setType(card?.type ?? 'qa');
    setBasis(card?.basis ?? 'outside');
    setTags(card?.tags.join(', ') ?? '');
    setLectureId(card?.lectureId ?? '');
  }, [open, card]);

  const save = async () => {
    setBusy(true);
    try {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (card) {
        await updateCard(db, card.id, { front, back, type, basis, tags: tagList, ...(lectureId ? { lectureId } : {}) });
        toast.show('Card saved.', 'ok');
      } else {
        await createCard(db, { courseId, type, front, back, basis, tags: tagList, ...(lectureId ? { lectureId } : {}) });
        toast.show('Card added.', 'ok');
      }
      onClose();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not save the card.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={card ? 'Edit card' : 'New card'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="card-form" disabled={busy || !front.trim() || !back.trim()}>
            {card ? 'Save card' : 'Add card'}
          </Button>
        </>
      }
    >
      <form
        id="card-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Kind of card" htmlFor="card-type">
            <Select id="card-type" value={type} onChange={(e) => setType(e.target.value as CardType)}>
              {CARD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CARD_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Where does it come from?" htmlFor="card-basis">
            <Select id="card-basis" value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {BASIS_LABEL[b]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lecture" htmlFor="card-lecture">
            <Select id="card-lecture" value={lectureId} onChange={(e) => setLectureId(e.target.value)}>
              <option value="">None</option>
              {lectures.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Front (the question)" htmlFor="card-front" hint="Markdown works. Write maths as $x^2$ and code in ``` fences.">
          <TextArea id="card-front" rows={3} value={front} onChange={(e) => setFront(e.target.value)} />
        </Field>
        <Field label="Back (the answer)" htmlFor="card-back">
          <TextArea id="card-back" rows={4} value={back} onChange={(e) => setBack(e.target.value)} />
        </Field>
        <Field label="Tags" htmlFor="card-tags" hint="Separate with commas.">
          <TextInput id="card-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-medium">Front preview</h3>
            <div className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 p-3">{front.trim() ? <LazyMarkdown>{front}</LazyMarkdown> : <span className="text-sm text-ink-3">Nothing yet</span>}</div>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">Back preview</h3>
            <div className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 p-3">{back.trim() ? <LazyMarkdown>{back}</LazyMarkdown> : <span className="text-sm text-ink-3">Nothing yet</span>}</div>
          </div>
        </div>
        {card && card.sources.length > 0 && <SourceList sources={card.sources} />}
      </form>
    </Dialog>
  );
}
