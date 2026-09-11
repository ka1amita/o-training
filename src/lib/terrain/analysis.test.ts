import { describe, it, expect } from 'vitest';
import { seeded } from '../rng.ts';
import { analyse, classifyLandform, drawnExtent } from './analysis.ts';
import { contributionOf, heightGrid, type Grid } from './height.ts';
import { insideCrop, type OMap, type Vec } from './omap.ts';
import { NoRelief, type Landform } from './relief.ts';
import { generateTerrain, paramsFor } from './terrain.ts';

/**
 * What the classifier can and cannot tell, measured rather than asserted.
 *
 * Two oracles, because neither alone is honest about this ground:
 *
 * 1. **The contours the map draws.** A card shows lines, and the player names what the
 *    lines show: a point the contour immediately below it closes around is a knoll,
 *    whatever put it there. This is the semantics the drill is scored against, and it is
 *    computed here from `relief.contours` — a marching-squares trace at a different
 *    resolution from the grid the classifier probes — so it is a check and not an echo.
 * 2. **The generator's own landform list.** Reliable about *up or down* and about where
 *    ground was shaped, and measurably unreliable about which form the map ends up
 *    drawing: a spur bump's falloff along its own crest beats the regional tilt more often
 *    than not, so the ground it draws closes a contour and reads as an elongated knoll.
 *    Measured below: 40 of 58 candidates standing on a spur bump are inside a closed ring.
 *
 * The thresholds are what was measured, less a little slack, so this table is a tripwire
 * on the classifier and not a wish about it.
 */
const SIZE = 420;
const INTERVAL = 5;

const gridOf = (f: (x: number, y: number) => number, size = SIZE, n = 64): Grid =>
  heightGrid({ heightAt: f }, size, n);

/** A slope falling to the east at one in eight, which is ordinary forest ground. */
const slope = (x: number, y: number) => 40 - x / 8 + y * 0;

/** One landform on that slope, through the same summation the generator uses. */
const withForm = (form: Landform) => (x: number, y: number) =>
  slope(x, y) + contributionOf(form, x, y);

const at = (x: number, y: number): Vec => ({ x, y });

/**
 * A generated map with its analysis taken off it, which is what an imported map looks like
 * to `analyse`: nobody has handed it a landform list, so it has to read the ground.
 */
const unread = (map: OMap): OMap => {
  const { analysis: _analysis, ...rest } = map;
  return rest;
};

describe('classifyLandform / ground whose form is known by construction', () => {
  it('names a closed rise a hill and a closed hollow a depression', () => {
    const hill = gridOf(withForm({
      kind: 'hill', x: 210, y: 210, radius: 70, amplitude: 18, rotation: 0, elongation: 1,
    }));
    expect(classifyLandform(hill, at(210, 210), 60, 18).form).toBe('hill');
    expect(classifyLandform(hill, at(210, 210), 60, 18).confidence).toBe(1);

    const pit = gridOf(withForm({
      kind: 'depression', x: 210, y: 210, radius: 70, amplitude: -18, rotation: 0, elongation: 1,
    }));
    expect(classifyLandform(pit, at(210, 210), 60, -18).form).toBe('depression');
  });

  it('names ground that runs back into the hillside a spur, and its opposite a re-entrant', () => {
    // Elongated along the fall, which is what makes it a spur rather than a bench: the
    // slope falls east, so the form is laid east-west and runs down it. Long and low
    // enough that the slope beats its own falloff along the crest — a short, tall one is
    // an elongated knoll and the classifier says so, which is the whole finding behind
    // the measured table below.
    const spur = gridOf(withForm({
      kind: 'spur', x: 210, y: 210, radius: 45, amplitude: 10, rotation: 0, elongation: 4,
    }));
    expect(classifyLandform(spur, at(210, 210), 50, 7.2).form).toBe('spur');

    const gully = gridOf(withForm({
      kind: 'reentrant', x: 210, y: 210, radius: 45, amplitude: -10, rotation: 0, elongation: 4,
    }));
    expect(classifyLandform(gully, at(210, 210), 50, -7.2).form).toBe('reentrant');
  });

  it('calls a col a saddle, which the answer space has no word for', () => {
    // Two hills with a gap between them: at the gap the ground climbs two ways and falls
    // two ways, and that is the one form whose centre is neither a high nor a low.
    const hills = (x: number, y: number) =>
      slope(x, y)
      + contributionOf({ kind: 'hill', x: 210, y: 110, radius: 140, amplitude: 25, rotation: 0, elongation: 1 }, x, y)
      + contributionOf({ kind: 'hill', x: 210, y: 310, radius: 140, amplitude: 25, rotation: 0, elongation: 1 }, x, y);
    const col = classifyLandform(gridOf(hills), at(210, 210), 45, -0.7);
    expect(col.form).toBe('saddle');
    // ...and `landformsOf` therefore leaves it unnamed, because `LandformKind` cannot
    // carry the word and a drill that cannot name a form must not be handed one.
    const map: OMap = {
      id: 'col', width: SIZE, height: SIZE, scale: 15000,
      relief: { kind: 'grid', heightAt: hills, sampleGrid: (n: number) => gridOf(hills, SIZE, n),
        contours: () => [], warped() { return this; } },
      features: [{ id: 'f', code: '206', geometry: { kind: 'point', at: at(210, 210) } }],
    };
    for (const form of analyse(map).landforms) expect(form.kind).not.toBe('saddle');
  });

  it('names nothing on a plane, however steep, and nothing on a rise the map would not draw', () => {
    expect(classifyLandform(gridOf(slope), at(210, 210), 60, 0).form).toBeUndefined();
    // ...and a two-metre rise on that slope changes nothing, because the slope is what the
    // rays are reading: eight fall, eight climb, and neither side is the majority a form
    // has to stand out by. This is the case `PROFILE_MAJORITY` exists for.
    const gentle = gridOf(withForm({
      kind: 'hill', x: 210, y: 210, radius: 70, amplitude: 2, rotation: 0, elongation: 1,
    }), SIZE);
    const form = classifyLandform(gentle, at(210, 210), 60, 2);
    expect(form.form).toBeUndefined();
    expect(form.confidence).toBeLessThan(0.875);
  });

  it('measures the axis of an elongated form, named or not', () => {
    const spur = gridOf(withForm({
      kind: 'spur', x: 210, y: 210, radius: 30, amplitude: 10, rotation: Math.PI / 5, elongation: 4,
    }));
    const form = classifyLandform(spur, at(210, 210), 40, 6);
    // The region is the ground within one and a half candidate radii, so a form longer
    // than that is measured less elongated than it is: 1.6 for an ellipse built at 4. The
    // ratio is a hint; the direction is the measurement, and that is what is used.
    expect(form.elongation).toBeGreaterThan(1.4);
    // Within fifteen degrees of the axis it was built on, modulo a half turn — an axis has
    // no direction, and `standsOut` probes across it either way.
    const turn = Math.abs(((form.rotation ?? 0) - Math.PI / 5) % Math.PI);
    expect(Math.min(turn, Math.PI - turn)).toBeLessThan(0.26);
  });
});

/**
 * The table. Every candidate on a hundred generated maps, classified as if nobody knew
 * what was there, scored against both oracles.
 */
interface Tally {
  named: number;
  drawnRight: number;
  genSeen: number;
  genRight: number;
  signRight: number;
  found: Set<string>;
  truths: number;
}

const KINDS = ['hill', 'depression', 'spur', 'reentrant'] as const;
const HIGH: readonly string[] = ['hill', 'spur'];

function insideRing(ring: readonly Vec[], p: Vec): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

function measure() {
  const tally = new Map<string, Tally>(
    KINDS.map((k) => [k, { named: 0, drawnRight: 0, genSeen: 0, genRight: 0, signRight: 0, found: new Set<string>(), truths: 0 }]),
  );
  let candidates = 0;
  let closedOnSpurs = 0;
  let onSpurs = 0;

  for (const level of [1, 3, 5, 7, 10]) {
    for (let seed = 1; seed <= 20; seed++) {
      const map = generateTerrain(seeded(seed * 7919 + level), paramsFor(level));
      const grid = map.relief.sampleGrid(64);
      // Ordinary lines only: a form line is half an interval and is the cartographer
      // saying the interval missed something, not a closed form.
      const rings = map.relief.contours(INTERVAL).filter((c) => c.closed && !c.form);
      const closesAt = (level_: number, p: Vec) =>
        rings.some((r) => Math.abs(r.level - level_) < 1e-6 && insideRing(r.points, p));
      for (const truth of map.relief.landforms) tally.get(truth.kind)!.truths++;

      // As if the landforms were unknown: no `landforms` option, so the analysis reads the
      // ground exactly as it does for an imported map.
      const forms = analyse(unread(map)).landforms;
      candidates += forms.length;
      for (const form of forms) {
        let dominant: Landform | null = null;
        let strongest = 0;
        for (const truth of map.relief.landforms) {
          const share = Math.abs(contributionOf(truth, form.centre.x, form.centre.y));
          if (share > strongest) {
            strongest = share;
            dominant = truth;
          }
        }
        const height = grid.values[0] === undefined ? 0 : map.relief.heightAt(form.centre.x, form.centre.y);
        const below = Math.floor(height / INTERVAL) * INTERVAL;
        const drawn = closesAt(below, form.centre) ? 'high'
          : closesAt(below + INTERVAL, form.centre) ? 'low'
          : 'open';
        if (dominant && strongest >= 3 && dominant.kind === 'spur') {
          onSpurs++;
          if (drawn !== 'open') closedOnSpurs++;
        }
        if (!form.kind) continue;
        const row = tally.get(form.kind)!;
        row.named++;
        const wanted = form.kind === 'hill' ? 'high' : form.kind === 'depression' ? 'low' : 'open';
        if (drawn === wanted) row.drawnRight++;
        if (dominant && strongest >= 3) {
          row.genSeen++;
          if (HIGH.includes(form.kind) === HIGH.includes(dominant.kind)) row.signRight++;
          if (dominant.kind === form.kind) {
            row.genRight++;
            row.found.add(`${level}-${seed}-${dominant.x}-${dominant.y}`);
          }
        }
      }
    }
  }
  return { tally, candidates, onSpurs, closedOnSpurs };
}

describe('classifyLandform / measured on generated maps', () => {
  const { tally, candidates, onSpurs, closedOnSpurs } = measure();
  const row = (kind: (typeof KINDS)[number]) => tally.get(kind)!;
  const share = (n: number, d: number) => (d === 0 ? 0 : n / d);

  it('names a hill or a depression the drawn contours agree with', () => {
    // Measured: hill 133 named at 0.95, depression 101 at 0.97. The slack is a tenth,
    // which is about one map's worth of candidates.
    expect(row('hill').named).toBeGreaterThanOrEqual(110);
    expect(share(row('hill').drawnRight, row('hill').named)).toBeGreaterThanOrEqual(0.9);
    expect(row('depression').named).toBeGreaterThanOrEqual(80);
    expect(share(row('depression').drawnRight, row('depression').named)).toBeGreaterThanOrEqual(0.92);
  });

  it('names spurs and re-entrants rarely here, and says so rather than guessing', () => {
    // Measured: spur 21 named at 0.52 against the drawn contours, re-entrant 17 at 0.94.
    // Low counts and, for the spur, the weakest precision in the table — this is the
    // honest number and not a target. It is low for a reason the next test states.
    expect(row('spur').named).toBeGreaterThanOrEqual(10);
    expect(share(row('spur').drawnRight, row('spur').named)).toBeGreaterThanOrEqual(0.45);
    expect(row('reentrant').named).toBeGreaterThanOrEqual(10);
    expect(share(row('reentrant').drawnRight, row('reentrant').named)).toBeGreaterThanOrEqual(0.85);
  });

  it('never gets up and down the wrong way round', () => {
    // The half of the question the generator's list *is* an oracle for, and the half a
    // player would notice first: a knoll named as a hollow is not a hard card, it is a
    // wrong one. Measured at 1.00 for all four kinds.
    for (const kind of KINDS) {
      expect(share(row(kind).signRight, row(kind).genSeen)).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('finds about half of the hills and depressions the generator placed', () => {
    // Recall against the list, not against the drawing. Measured: hill 0.47,
    // depression 0.57. The rest are landforms whose ground the summation left open.
    expect(share(row('hill').found.size, row('hill').truths)).toBeGreaterThanOrEqual(0.40);
    expect(share(row('depression').found.size, row('depression').truths)).toBeGreaterThanOrEqual(0.45);
  });

  it('records why the generator is a poor oracle for spurs', () => {
    // 40 of 58 candidates standing on a spur bump are inside a closed contour ring: the
    // bump's falloff along its own crest is steeper than the regional tilt, so the map
    // draws an elongated knoll. Naming that ground a spur would be naming the parameter
    // rather than the map, which is why spur precision against the *list* is 0.30 while
    // hill precision against the *drawing* is 0.95.
    expect(onSpurs).toBeGreaterThan(40);
    expect(closedOnSpurs / onSpurs).toBeGreaterThan(0.5);
  });

  it('leaves most candidates unnamed, because most of them are micro-relief', () => {
    // 272 of 3500. A generated map carries a metre of noise at a sixty-metre wavelength
    // and curvature finds all of it; the interval a ray has to cross is what refuses it.
    // This is the measurement behind `candidatesOf` in `terrain.ts` handing the generator's
    // own landforms over instead — the classifier agrees with that decision rather than
    // undermining it.
    const named = KINDS.reduce((sum, k) => sum + row(k).named, 0);
    expect(candidates).toBeGreaterThan(3000);
    expect(named / candidates).toBeLessThan(0.15);
    expect(named).toBeGreaterThan(150);
  });
});

describe('analyse', () => {
  it('takes the landforms a source hands it, kinds and all, and reads none itself', () => {
    const map = generateTerrain(seeded(4321), paramsFor(6));
    // The generated map's own analysis: every candidate is one of its landforms, named.
    expect(map.analysis!.landforms.length).toBe(map.relief.landforms.length);
    for (const form of map.analysis!.landforms) expect(form.kind).toBeDefined();
  });

  it('clips candidates to the ground the surveyor drew', () => {
    const map = generateTerrain(seeded(99), paramsFor(8));
    const drawn = drawnExtent(map);
    const read = analyse(unread(map)).landforms;
    for (const form of read) {
      expect(form.centre.x).toBeGreaterThanOrEqual(drawn.minX);
      expect(form.centre.x).toBeLessThanOrEqual(drawn.maxX);
      expect(form.centre.y).toBeGreaterThanOrEqual(drawn.minY);
      expect(form.centre.y).toBeLessThanOrEqual(drawn.maxY);
    }
  });

  it('has no landforms to read on a map with no relief', () => {
    const flat: OMap = {
      id: 'flat', width: 100, height: 100, scale: 10000, relief: new NoRelief(100), features: [],
    };
    expect(analyse(flat).landforms).toEqual([]);
    // ...and `drawnExtent` falls back to the whole map rather than to an empty box, or
    // every window on a featureless map would be outside the drawing.
    expect(drawnExtent(flat)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it('keeps every candidate inside the crop it is offered to', () => {
    // Not a property of the classifier, but the one thing every consumer assumes: a
    // candidate's centre is a point on the map, so `insideCrop` decides what a window holds.
    const map = generateTerrain(seeded(7), paramsFor(5));
    const crop = { x: 0, y: 0, size: map.width };
    for (const form of analyse(unread(map)).landforms) {
      expect(insideCrop(form.centre, crop)).toBe(true);
    }
  });
});
