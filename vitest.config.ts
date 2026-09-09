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
    /**
     * The terrain properties are CPU-bound, and the default five seconds is wall clock.
     *
     * A pexeso property is 120 rounds of six generated maps, about six seconds of work on
     * its own, and vitest runs one worker per file — two dozen of them over the two cores
     * a CI runner has. So the time any one test takes depends on how many *other* files
     * exist, and at the default a green suite turned red the day two test files were
     * added, with no test asserting anything new. A timeout is there to catch a hang; it
     * is not a performance budget, and one that moves when a neighbour appears measures
     * the machine rather than the code.
     */
    testTimeout: 30_000,
  },
});
