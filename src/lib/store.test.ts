import { describe, it, expect } from 'vitest';
import { memoryStore, loadProgress, saveSession, clearAll, EMPTY, HISTORY_LIMIT } from './store.ts';
import type { SessionSummary } from './session.ts';

const summary = (at: number): SessionSummary => ({
  drillId: 'match', finishedAt: at, rounds: 10, correct: 8, total: 10,
  accuracy: 0.8, medianResponseMs: 900, endLevel: 4, bestStreak: 5,
});

describe('store', () => {
  it('reads nothing as no progress', async () => {
    expect(await loadProgress(memoryStore(), 'match')).toEqual(EMPTY);
  });

  it('round-trips a session and the level', async () => {
    const kv = memoryStore();
    await saveSession(kv, 'match', summary(1), 4);
    const p = await loadProgress(kv, 'match');
    expect(p.level).toBe(4);
    expect(p.sessions).toHaveLength(1);
  });

  it('keeps drills apart', async () => {
    const kv = memoryStore();
    await saveSession(kv, 'match', summary(1), 4);
    expect((await loadProgress(kv, 'dobble')).sessions).toHaveLength(0);
  });

  it('caps history and keeps the most recent', async () => {
    const kv = memoryStore();
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) await saveSession(kv, 'match', summary(i), 3);
    const p = await loadProgress(kv, 'match');
    expect(p.sessions).toHaveLength(HISTORY_LIMIT);
    expect(p.sessions.at(-1)!.finishedAt).toBe(HISTORY_LIMIT + 24);
    expect(p.sessions[0]!.finishedAt).toBe(25);
  });

  it('treats a malformed record as no progress rather than throwing', async () => {
    // A browser that cleared half its storage, or a record from an older build.
    for (const junk of [null, 42, 'nonsense', {}, { level: 'x', sessions: [] }, { level: 1 }]) {
      const kv = memoryStore({ 'drill:match': junk });
      expect(await loadProgress(kv, 'match')).toEqual(EMPTY);
    }
  });

  it('clearAll removes drill data and leaves anything else alone', async () => {
    const kv = memoryStore({ 'settings:theme': 'dark' });
    await saveSession(kv, 'match', summary(1), 4);
    await clearAll(kv);
    expect(await kv.keys()).toEqual(['settings:theme']);
  });
});
