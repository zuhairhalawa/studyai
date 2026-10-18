import { parsePptx, PptxError } from '@/core/pptx';

/** Parses a PowerPoint file off the main thread so the UI stays responsive. */
const post = (message: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

self.onmessage = async (e: MessageEvent<{ bytes: Uint8Array }>) => {
  try {
    const deck = await parsePptx(e.data.bytes, { onProgress: (done, total) => post({ type: 'progress', done, total }) });
    post({ type: 'done', deck });
  } catch (err) {
    post({
      type: 'error',
      code: err instanceof PptxError ? err.code : 'UNKNOWN',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
