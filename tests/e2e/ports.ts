/**
 * The local ports of the browser tests: the production build (`preview`), the real local Worker with the scripted fake model
 * (`worker`), the same Worker behind the sign-in gate (`gate`) and a stand-in for Google's endpoint (`stub`).
 *
 * The defaults are fixed numbers. On a machine where the system has reserved them (Windows does this for some ranges, and the
 * tests then stop with "listen EACCES"), set `STUDYAI_E2E_PORT_BASE=24000` to use 24000 to 24003 instead.
 */
const base = Number(process.env['STUDYAI_E2E_PORT_BASE'] ?? '') || 0;

export const PORTS = base > 0 ? { preview: base, worker: base + 1, gate: base + 2, stub: base + 3 } : { preview: 4391, worker: 8792, gate: 8793, stub: 8795 };

export const ORIGINS = {
  preview: `http://127.0.0.1:${PORTS.preview}`,
  worker: `http://127.0.0.1:${PORTS.worker}`,
  gate: `http://127.0.0.1:${PORTS.gate}`,
  stub: `http://127.0.0.1:${PORTS.stub}`,
};
