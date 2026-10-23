import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { renderHeadersFile, SECURITY_HEADERS } from './config/headers.ts';

/** Emits dist/_headers so Cloudflare serves the same CSP/security headers the preview server used in tests. */
function securityHeadersFile(): Plugin {
  return {
    name: 'studyai-security-headers',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: renderHeadersFile() });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), securityHeadersFile()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2023',
    sourcemap: false,
    // Never inline assets as data: URIs: the CSP only allows fonts/images from our own origin.
    assetsInlineLimit: 0,
  },
  // The library lives in IndexedDB, which the browser scopes to the exact address. If port 5173 were busy, Vite would
  // quietly move to 5174 and the student would see an empty library; stop with an error instead (`--port` overrides).
  server: { port: 5173, strictPort: true },
  // `vite preview` serves the production build with the production policy.
  preview: { headers: SECURITY_HEADERS },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // UI/IndexedDB tests opt in with: // @vitest-environment happy-dom
    testTimeout: 20_000,
  },
});
