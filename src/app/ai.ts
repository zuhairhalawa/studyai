import { useSyncExternalStore } from 'react';
import type { AiReply, AiTask, OwnerStatus } from '@/core/tutor/contract';

/**
 * The browser's only connection to the AI server (the Worker). Everything is same-origin: the page's CSP forbids any other
 * address. The server is optional: when the app is opened without it (plain dev server, a static copy), every AI feature
 * explains that and the rest of the app works exactly as before. Nothing here is called until an AI screen is opened.
 */

export type AiPhase =
  | 'loading' // asking the server
  | 'unavailable' // this copy of the app has no AI server
  | 'unconfigured' // the server is there but the owner key / session secret are not set
  | 'signed-out'
  | 'ready';

export interface AiState {
  phase: AiPhase;
  status?: OwnerStatus;
}

let state: AiState = { phase: 'loading' };
const listeners = new Set<() => void>();
function set(next: AiState): void {
  state = next;
  for (const l of listeners) l();
}

interface Json {
  status: number;
  body: unknown;
}

/** A same-origin JSON request. Returns undefined when the answer is not JSON from this server (e.g. a static file server). */
async function call(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}): Promise<Json | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      signal: ctl.signal,
      ...(init.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
    });
    if (!/^application\/json/i.test(res.headers.get('content-type') ?? '')) return undefined;
    return { status: res.status, body: await res.json() };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

let inflight: Promise<void> | undefined;

/** Finds out whether there is a server, whether it is set up, and whether the owner is signed in. */
export function refreshAi(): Promise<void> {
  inflight ??= (async () => {
    try {
      const health = await call('/api/health');
      if (!health || (health.body as { service?: unknown } | null)?.service !== 'studyai') return set({ phase: 'unavailable' });
      const session = await call('/api/auth/session');
      const s = session?.body as { authenticated?: boolean; configured?: boolean } | undefined;
      if (!s) return set({ phase: 'unavailable' });
      if (!s.configured) return set({ phase: 'unconfigured' });
      if (!s.authenticated) return set({ phase: 'signed-out' });
      const status = await call('/api/owner/status');
      if (status?.status === 200) return set({ phase: 'ready', status: status.body as OwnerStatus });
      return set({ phase: 'signed-out' });
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** Only the owner status (usage, settings): cheaper than a full refresh, used after every action. */
async function refreshStatus(): Promise<void> {
  if (state.phase !== 'ready') return;
  const status = await call('/api/owner/status');
  if (status?.status === 200) set({ phase: 'ready', status: status.body as OwnerStatus });
  else if (status?.status === 401) set({ phase: 'signed-out' });
}

export type LoginResult = { ok: true } | { ok: false; message: string };

export async function loginOwner(key: string): Promise<LoginResult> {
  const r = await call('/api/auth/login', { method: 'POST', body: { key: key.trim() } });
  if (!r) return { ok: false, message: 'Could not reach the AI server.' };
  if (r.status === 200) {
    await refreshAi();
    return { ok: true };
  }
  if (r.status === 429) {
    const wait = Number((r.body as { retryAfterSec?: unknown }).retryAfterSec);
    return { ok: false, message: `Too many wrong attempts. Try again in ${Number.isFinite(wait) ? Math.max(1, Math.ceil(wait / 60)) : 15} minutes.` };
  }
  if (r.status === 503) return { ok: false, message: 'The server is not set up yet (owner key missing).' };
  return { ok: false, message: 'That key was not accepted.' };
}

export async function logoutOwner(everywhere = false): Promise<void> {
  await call(everywhere ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST', body: {} });
  set({ phase: 'signed-out' });
}

export type OwnerResult = { ok: true } | { ok: false; error: string };

/** Owner actions (settings, confirmations, reconcile). The server validates everything again. */
export async function ownerAction(path: 'config' | 'attest' | 'revoke' | 'reconcile' | 'reset-pause', body: unknown): Promise<OwnerResult> {
  const r = await call(`/api/owner/${path}`, { method: 'POST', body });
  if (!r) return { ok: false, error: 'Could not reach the AI server.' };
  if (r.status === 401) {
    set({ phase: 'signed-out' });
    return { ok: false, error: 'You are signed out.' };
  }
  const b = r.body as { ok?: boolean; error?: string };
  await refreshStatus();
  return b.ok ? { ok: true } : { ok: false, error: b.error ?? 'The change was refused.' };
}

/** Sends one structured task. Never throws; a refusal or failure comes back with a plain-language message. */
export async function askAi(task: AiTask): Promise<AiReply> {
  const r = await call('/api/ai/ask', { method: 'POST', body: task, timeoutMs: 120_000 });
  if (!r) return { ok: false, code: 'network', message: 'Could not reach the AI server. Your slides were not sent anywhere unless it answered.' };
  if (r.status === 401) {
    set({ phase: 'signed-out' });
    return { ok: false, code: 'signed-out', message: 'You are signed out. Sign in again in Settings.' };
  }
  const b = r.body as Partial<AiReply> & { error?: string };
  void refreshStatus(); // keeps the usage numbers current; failures are harmless
  if (b && typeof b === 'object' && typeof b.ok === 'boolean') return b as AiReply;
  return { ok: false, code: 'server-error', message: 'The AI server answered in an unexpected way.' };
}

export function useAiServer(): AiState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
