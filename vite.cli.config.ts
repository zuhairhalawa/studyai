import { defineConfig } from 'vite';

/** Bundles the Node command-line tool used by the Claude Code skill: `pnpm cli:build` → dist-cli/lecture-cli.mjs */
export default defineConfig({
  build: {
    ssr: 'src/cli/main.ts',
    outDir: 'dist-cli',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'lecture-cli.mjs' } },
  },
  ssr: { noExternal: true, target: 'node' },
});
