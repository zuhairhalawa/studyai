import type { AiReply, AiTask } from '@/core/tutor/contract';
import type { AiState, LoginResult, OwnerResult } from './ai';

/**
 * Stands in for ./ai.ts in the static demo build (vite.config.ts swaps the module, docs/DEMO.md). It has no fetch, no address and
 * no state: every AI screen sees "unavailable" and says so, exactly as in a copy of the app with no AI server. The demo therefore
 * cannot send a request to a Worker, a provider or anyone else, and the bundle contains no code that could.
 * tests/demo.ai-stub.test.ts keeps its exports identical to ./ai.ts.
 */

const UNAVAILABLE: AiState = { phase: 'unavailable' };
const WHY = 'AI features are not available in the demo.';

export function refreshAi(): Promise<void> {
  return Promise.resolve();
}

export function loginOwner(_key: string): Promise<LoginResult> {
  return Promise.resolve({ ok: false, message: WHY });
}

export function logoutOwner(_everywhere = false): Promise<void> {
  return Promise.resolve();
}

export function ownerAction(_path: 'config' | 'attest' | 'revoke' | 'reconcile' | 'reset-pause', _body: unknown): Promise<OwnerResult> {
  return Promise.resolve({ ok: false, error: WHY });
}

export function askAi(_task: AiTask): Promise<AiReply> {
  return Promise.resolve({ ok: false, code: 'unavailable', message: WHY });
}

export function useAiServer(): AiState {
  return UNAVAILABLE;
}
