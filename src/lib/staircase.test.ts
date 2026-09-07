import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { advance, initial, RUN_TO_ADVANCE, type StaircaseBounds } from './staircase.ts';

const B: StaircaseBounds = { min: 1, max: 10 };
const run = (correct: boolean[], bounds = B, start = 5) =>
  correct.reduce((s, c) => advance(s, c, bounds), initial(bounds, start));

describe('staircase', () => {
  it('takes three correct to move up, and not two', () => {
    expect(run([true, true]).level).toBe(5);
    expect(run([true, true, true]).level).toBe(6);
  });

  it('moves down on a single miss', () => {
    expect(run([false]).level).toBe(4);
  });

  it('resets the run on advancing, so six correct is two steps', () => {
    expect(run(Array(6).fill(true)).level).toBe(7);
  });

  it('resets the run on a miss, so a near-miss streak does not carry over', () => {
    expect(run([true, true, false, true, true]).level).toBe(4);
  });

  it('clamps at both bounds', () => {
    expect(run(Array(30).fill(false), B, 5).level).toBe(1);
    expect(run(Array(60).fill(true), B, 5).level).toBe(10);
  });

  it('clamps the starting level too', () => {
    expect(initial(B, 99).level).toBe(10);
    expect(initial(B, -5).level).toBe(1);
  });

  it('never leaves the bounds, for any sequence', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 300 }), (answers) => {
        const end = run(answers);
        expect(end.level).toBeGreaterThanOrEqual(B.min);
        expect(end.level).toBeLessThanOrEqual(B.max);
        expect(end.runOfCorrect).toBeLessThan(RUN_TO_ADVANCE);
      }),
    );
  });

  it('converges near 79% — an observer better than that drifts up, worse drifts down', () => {
    // The defining property of 3-down-1-up. Simulated with a fixed-skill observer:
    // at p = 0.95 the level should climb, at p = 0.50 it should fall.
    const simulate = (p: number, seed: number) => {
      let s = initial({ min: 1, max: 40 }, 20);
      let x = seed;
      for (let i = 0; i < 400; i++) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        s = advance(s, x / 0x1_0000_0000 < p, { min: 1, max: 40 });
      }
      return s.level;
    };
    expect(simulate(0.95, 7)).toBeGreaterThan(20);
    expect(simulate(0.5, 7)).toBeLessThan(20);
  });
});
