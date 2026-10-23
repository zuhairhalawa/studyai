import { afterEach, describe, expect, it, vi } from 'vitest';
import * as real from '../src/app/ai';
import * as stub from '../src/app/ai.demo';

/** The demo build swaps ../src/app/ai.ts for ../src/app/ai.demo.ts (vite.config.ts). A screen written for one must work with the other. */
const sameShape: typeof real = stub;

afterEach(() => vi.unstubAllGlobals());

describe('the demo AI stub', () => {
  it('offers exactly what the real client offers, with the same types', () => {
    expect(Object.keys(stub).sort()).toEqual(Object.keys(real).sort());
    expect(sameShape).toBe(stub);
  });

  it('says "unavailable", which every AI screen already explains', () => {
    expect(stub.useAiServer()).toEqual({ phase: 'unavailable' });
  });

  it('refuses every action with a plain message and never touches the network', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('the demo must not call fetch')));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('XMLHttpRequest', class { constructor() { throw new Error('the demo must not use XMLHttpRequest'); } });
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('the demo must not open a WebSocket'); } });

    await stub.refreshAi();
    await stub.logoutOwner(true);
    expect(await stub.loginOwner('any key')).toEqual({ ok: false, message: 'AI features are not available in the demo.' });
    expect(await stub.ownerAction('config', {})).toEqual({ ok: false, error: 'AI features are not available in the demo.' });
    const reply = await stub.askAi({ task: 'tutor', mode: 'explain', question: 'Why?', excerpts: [{ ref: 'S1', lectureTitle: 'L', slide: 1, title: 'T', text: 'x' }], history: [] });
    expect(reply).toEqual({ ok: false, code: 'unavailable', message: 'AI features are not available in the demo.' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the real client, for contrast', () => {
  it('does ask a server (which is why the demo must not contain it)', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('<html></html>', { headers: { 'content-type': 'text/html' } })));
    vi.stubGlobal('fetch', fetchSpy);
    await real.refreshAi();
    expect(fetchSpy).toHaveBeenCalledWith('/api/health', expect.anything());
  });
});
