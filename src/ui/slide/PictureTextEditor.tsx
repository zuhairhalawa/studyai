import { useEffect, useId, useState } from 'react';
import { PICTURE_TEXT_MAX } from '@/core/pptx/picturetext';
import { Button, Field, TextArea } from '@/ui/primitives';

/**
 * Where the student types the words of a picture (the labels of a diagram, the values in a screenshot). They are not in the
 * file as text, so nothing can read them for the student; once typed they become study text, marked as typed by the student.
 */
export function PictureTextEditor({ saved, onSave }: { saved: string; onSave: (text: string) => Promise<void> }) {
  const id = useId();
  const [text, setText] = useState(saved);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  useEffect(() => setText(saved), [saved]);
  const dirty = text.trim() !== saved.trim();

  const save = async (value: string) => {
    setState('saving');
    try {
      await onSave(value);
      setState('saved');
    } catch {
      setState('error');
    }
  };

  return (
    // The block around this is clickable (it highlights the shape); typing here must not toggle it.
    <div className="mt-3 w-full" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Field
        label="Words in this picture"
        htmlFor={id}
        hint="Type or paste what the picture says: labels, values, steps. It is added to this slide’s study text, so search, the tutor, flashcards and exams can use it. It is always marked as typed by you."
      >
        <TextArea
          id={id}
          rows={6}
          maxLength={PICTURE_TEXT_MAX}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setState('idle');
          }}
          className="font-mono text-[13px]"
          spellCheck={false}
        />
      </Field>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={!dirty || state === 'saving'} onClick={() => void save(text)}>
          Save text
        </Button>
        {saved && (
          <Button variant="ghost" size="sm" disabled={state === 'saving'} onClick={() => void save('')}>
            Remove
          </Button>
        )}
        <span role="status" className="text-[13px] text-ink-2">
          {state === 'saved' ? (saved ? 'Saved.' : 'Removed.') : state === 'error' ? 'Could not save. Try again.' : ''}
        </span>
      </div>
    </div>
  );
}
