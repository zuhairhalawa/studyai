import { useState, type FormEvent } from 'react';
import { loginOwner } from '@/app/ai';
import { Button, Field, TextInput } from '@/ui/primitives';

/** The owner key is a long random key made once with `pnpm owner:keygen`. It is typed here, sent once over HTTPS, and never stored by this page. */
export function OwnerSignIn() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setError(undefined);
    const r = await loginOwner(key);
    setBusy(false);
    if (r.ok) setKey('');
    else setError(r.message);
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-md" aria-label="Owner sign-in">
      <Field label="Owner key" htmlFor="owner-key" hint="The long key made by “pnpm owner:keygen”. Only you have it; nobody else can use the AI part of this site.">
        <TextInput id="owner-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? 'owner-key-error' : undefined} />
      </Field>
      {error && (
        <p id="owner-key-error" role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      )}
      <div className="mt-3">
        <Button type="submit" variant="primary" disabled={busy || !key.trim()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </form>
  );
}
