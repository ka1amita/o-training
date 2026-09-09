import { describe, it, expect } from 'vitest';
import { contoursOf } from '@/lib/terrain/contours.ts';
import { heightGrid } from '@/lib/terrain/height.ts';
import { assignLevels, type ContourLine } from './levels.ts';

/**
 * Level assignment, tested against ground it already knows the answer for.
 *
 * The trick that makes this testable at all: trace contours from a height field, throw the
 * levels away, and ask the stage to put them back. Anything it gets wrong is a real
 * misreading of a real drawing, not a disagreement about a fixture — and the failures that
 * matter here are the quiet ones, a hillside read upside down or shifted by one interval,
 * which look perfectly plausible on a card.
 */
const SIZE = 400;
const INTERVAL = 5;

const drawn = (f: (x: number, y: number) => number, n = 128): ContourLine[] => {
  const grid = heightGrid({ heightAt: f }, SIZE, n);
  return contoursOf(grid, { interval: INTERVAL, resolution: n }).map((c) => ({
    points: c.points,
    closed: c.closed,
    index: c.index,
    form: false,
  }));
};

const traced = (f: (x: number, y: number) => number, n = 128) =>
  contoursOf(heightGrid({ heightAt: f }, SIZE, n), { interval: INTERVAL, resolution: n });

/**
 * Every assigned level, against the height of the ground the line was traced on.
 *
 * Compared through the field rather than by lining two arrays up, because `stitchPieces`
 * joins broken pieces and hands back a different number of lines in a different order —
 * and an index-by-index comparison would be testing that order rather than the levels.
 * The absolute datum is not recoverable, so both sides are shifted to put the lowest line
 * at zero; `mirrored` is for the case where the drawing says the hill is a hollow.
 */
const fits = (
  contours: readonly { level: number; points: readonly { x: number; y: number }[] }[],
  f: (x: number, y: number) => number,
  mirrored = false,
) => {
  const levels = traced(f).map((c) => c.level);
  const lowest = Math.min(...levels);
  const highest = Math.max(...levels);
  expect(contours.length).toBeGreaterThan(0);
  for (const contour of contours) {
    for (const p of contour.points) {
      const here = f(p.x, p.y);
      const expected = mirrored ? highest - here : here - lowest;
      expect(Math.abs(expected - contour.level)).toBeLessThan(1);
    }
  }
};

const hill = (x: number, y: number) => {
  const d = Math.hypot(x - 200, y - 200) / 150;
  return d >= 1 ? 0 : 40 * (1 - d * d) * (1 - d * d);
};

const slope = (x: number, y: number) => 0.09 * x + 0.03 * y;

const slopeWithKnoll = (x: number, y: number) => {
  const d = Math.hypot(x - 120, y - 300) / 55;
  return slope(x, y) + (d >= 1 ? 0 : 11 * (1 - d * d) * (1 - d * d));
};

describe('assignLevels / recovers what the tracer knew', () => {
  it('reads a hill right way up', () => {
    const result = assignLevels(drawn(hill), { interval: INTERVAL });
    if (!result.ok) throw new Error(`gave up: ${result.reason}`);
    fits(result.contours, hill);
  });

  it('reads a hillside crossed by parallel contours', () => {
    // The case nesting cannot solve: not one contour on this map closes, so every level
    // comes from the transect constraint and the phase from the index lines.
    const result = assignLevels(drawn(slopeWithKnoll), { interval: INTERVAL });
    if (!result.ok) throw new Error(`gave up: ${result.reason}`);
    fits(result.contours, slopeWithKnoll);
  });

  it('puts the index contours on multiples of five intervals', () => {
    const result = assignLevels(drawn(hill), { interval: INTERVAL });
    if (!result.ok) throw new Error(`gave up: ${result.reason}`);
    // Not automatic: the graph fixes the levels only up to an offset, and this is the one
    // thing in the drawing that says where the round numbers fall.
    const indexed = result.contours.filter((c) => c.index);
    expect(indexed.length).toBeGreaterThan(0);
    for (const line of indexed) {
      expect(Math.round(line.level / INTERVAL) % 5).toBe(0);
    }
  });

  it('turns a hill into a hollow when a slope line says so', () => {
    // The one statement of direction the drawing makes. Getting it wrong is invisible:
    // a knoll and a hollow are the same picture without the tick.
    const lines = drawn(hill);
    // On every ring, as a surveyor marks a depression: one tick on one ring of eight is
    // outvoted, and should be — a lone mark is far more likely to be a stray object than
    // a statement that the whole hill is inside out.
    const marks = lines.filter((l) => l.closed).map((l) => l.points[0]!);
    const result = assignLevels(lines, { interval: INTERVAL, slopeMarks: marks });
    if (!result.ok) throw new Error(`gave up: ${result.reason}`);
    // Every level mirrored: what was the summit is now the bottom of the hollow.
    fits(result.contours, hill, true);
  });

  it('puts a form line half an interval from its neighbour', () => {
    const lines = drawn(hill);
    const ordinary = lines.filter((l) => !l.closed || true);
    const one = ordinary[1]!;
    // A copy of a real contour, nudged, standing in for a form line between two others.
    const form: ContourLine = {
      points: one.points.map((p) => ({ x: p.x + 4, y: p.y + 4 })),
      closed: one.closed,
      index: false,
      form: true,
    };
    const result = assignLevels([...lines, form], { interval: INTERVAL });
    if (!result.ok) throw new Error(`gave up: ${result.reason}`);
    const drawnForm = result.contours.find((c) => c.form)!;
    expect(Math.abs((drawnForm.level / INTERVAL) % 1)).toBeCloseTo(0.5, 6);
  });
});

describe('assignLevels / gives up rather than guessing', () => {
  it('gives up on too few lines', () => {
    const result = assignLevels(drawn(hill).slice(0, 2), { interval: INTERVAL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/only 2 contour lines/);
  });

  it('gives up when the contours are not neighbours of each other', () => {
    // Two hills far apart with nothing between them: the drawing does not say whether one
    // is above the other, and inventing an answer puts a cliff between them.
    const far = [...drawn(hill).slice(0, 6), ...shifted(drawn(hill).slice(0, 6), 4000)];
    const result = assignLevels(far, { interval: INTERVAL, maxGap: 40 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/groups|neighbour|reached/);
  });

  it('gives up when nothing closes, so nothing says which way is up', () => {
    const open = drawn(slope).filter((l) => !l.closed);
    const result = assignLevels(open, { interval: INTERVAL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/which way is up/);
  });
});

const shifted = (lines: readonly ContourLine[], by: number): ContourLine[] =>
  lines.map((l) => ({ ...l, points: l.points.map((p) => ({ x: p.x + by, y: p.y })) }));
