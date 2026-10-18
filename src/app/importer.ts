import { DEFAULT_LIMITS, PptxError, parsePptx, type PptxErrorCode } from '@/core/pptx';
import type { ParsedDeck } from '@/core/pptx/model';

export interface ParsedFile {
  deck: ParsedDeck;
  bytes: Uint8Array;
}

const ACCEPTED = /\.(pptx|pptm|ppsx|potx)$/i;

export function isAcceptedFileName(name: string): boolean {
  return ACCEPTED.test(name);
}

/** Read and parse one file. Uses a Web Worker in the browser; runs inline where workers are unavailable (tests). */
export async function parseFile(file: File, onProgress?: (done: number, total: number) => void): Promise<ParsedFile> {
  if (!isAcceptedFileName(file.name)) {
    throw new PptxError('NOT_PPTX', /\.ppt$/i.test(file.name) ? 'This is an old .ppt file. Save it as .pptx in PowerPoint first.' : 'Only PowerPoint files (.pptx) can be imported.');
  }
  if (file.size > DEFAULT_LIMITS.maxFileBytes) {
    throw new PptxError('FILE_TOO_LARGE', `This file is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${DEFAULT_LIMITS.maxFileBytes / 1048576} MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (typeof Worker === 'undefined') {
    return { deck: await parsePptx(bytes, { onProgress }), bytes };
  }
  const deck = await new Promise<ParsedDeck>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; done?: number; total?: number; deck?: ParsedDeck; code?: PptxErrorCode | 'UNKNOWN'; message?: string };
      if (m.type === 'progress') onProgress?.(m.done ?? 0, m.total ?? 0);
      else if (m.type === 'done') {
        worker.terminate();
        resolve(m.deck!);
      } else if (m.type === 'error') {
        worker.terminate();
        reject(m.code && m.code !== 'UNKNOWN' ? new PptxError(m.code, m.message ?? '') : new Error(m.message ?? 'Unknown error'));
      }
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(ev.message || 'The file reader crashed.'));
    };
    worker.postMessage({ bytes });
  });
  return { deck, bytes };
}
