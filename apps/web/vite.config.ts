import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const sharedEntry = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));
const sharedSource = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));

function sharedSourcePlugin(): Plugin {
  return {
    name: 'stageflow-shared-source',
    enforce: 'pre',
    resolveId(id) {
      if (id === '@stageflow/shared') return sharedEntry;
      return null;
    },
    configureServer(server) {
      server.watcher.add(sharedSource);
    },
  };
}

export default defineConfig({
  plugins: [sharedSourcePlugin(), react(), tailwindcss()],
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  optimizeDeps: { exclude: ['@stageflow/shared'] },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
});
