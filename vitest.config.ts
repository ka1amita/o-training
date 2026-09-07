import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// Node-only. Nothing under test touches the DOM: every drill's generate/score is
// pure and the session and netcode are reducers, which is the point of the
// contract in AGENTS.md. Rendering is checked by eye, not here.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
