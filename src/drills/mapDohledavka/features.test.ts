import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { GeneratedProvider } from '@/lib/maps/provider.ts';
import { seeded } from '@/lib/rng.ts';
import { analyse } from '@/lib/terrain/analysis.ts';
import { ISOM_SCALE } from '@/lib/terrain/isom.ts';
import type { Feature, Vec } from '@/lib/terrain/omap.ts';
import { AnalyticRelief, type Landform } from '@/lib/terrain/relief.ts';
import { CODE_OF, SEMANTICS, semanticsOf, type IsomCode } from '@/lib/terrain/semantics.ts';
import type { GeneratedMap } from '@/lib/terrain/terrain.ts';
import { requirementFor, paramsFor, CIRCLE_FRACTION } from './drill.ts';
import {
  clearanceFrom, sitesOf, wordFor, CONTROL_NAMES, type ControlKind,
} from './features.ts';

/**
 * A bare 300 m map. `noiseSeed` 0 is the documented "no micro-relief" case in `noise.ts`.
 *
 * Built by hand rather than generated, so each test states exactly the one thing it is
 * about: the ring rules are about what is on the map, not about how it got there.
 */
const ground = (over: {
  readonly landforms?: readonly Landform[];
  readonly features?: readonly Feature[];
} = {}): GeneratedMap => {
  const size = 300;
  const landforms = over.landforms ?? [];
  const map: GeneratedMap = {
    id: 'generated',
    width: size,
    height: size,
    scale: ISOM_SCALE,
    relief: new AnalyticRelief({ size, tilt: { x: 0.06, y: 0 }, noiseSeed: 0, landforms }),
    features: over.features ?? [],
  };
  // The drill reads landforms off the analysis, exactly as `generateTerrain` hands them
  // over: the candidates *are* the forms the map was built from.
  return {
    ...map,
    analysis: analyse(map, {
      landforms: landforms.map((f) => ({
        centre: { x: f.x, y: f.y },
        radius: f.radius * f.elongation,
        amplitude: f.amplitude,
        kind: f.kind,
        rotation: f.rotation,
        elongation: f.elongation,
      })),
    }),
  };
};

/** A card is a window; here it is the whole of the little map. */
const WHOLE = { x: 0, y: 0, size: 300 };

type Kind = keyof typeof CODE_OF;

let ids = 0;
const line = (code: IsomCode, points: readonly Vec[]): Feature => ({
  id: `line-${code}-${ids++}`, code, geometry: { kind: 'polyline', points },
});

const area = (code: IsomCode, ring: readonly Vec[]): Feature => ({
  id: `area-${code}-${ids++}`, code, geometry: { kind: 'polygon', rings: [ring] },
});

const at = (code: IsomCode, x: number, y: number, size = 4): Feature => ({
  id: `point-${code}-${x}-${y}`, code, geometry: { kind: 'point', at: { x, y } }, size,
});

const point = (kind: Kind, x: number, y: number, size: number): Feature => ({
  ...at(CODE_OF[kind], x, y, size), kind,
});

const box = (x: number, y: number, w: number, h: number): Vec[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

const RADIUS = 15;
const kindsOf = (map: GeneratedMap) => sitesOf(map, WHOLE, RADIUS).map((s) => s.kind);

describe('the vocabulary', () => {
  it('gives every control site a word, and every word a name', () => {
    // The list is the semantic table's. A `controlSite` code with no word would be a
    // symbol the drill can circle and cannot say anything about.
    for (const semantics of Object.values(SEMANTICS)) {
      const word = wordFor(semantics.code);
      if (!semantics.controlSite) {
        expect(word, `${semantics.code} is not a control site`).toBeUndefined();
        continue;
      }
      expect(word, `${semantics.code} has no word`).toBeDefined();
      expect(CONTROL_NAMES[word!], `${word} has no name`).toBeTruthy();
    }
  });

  it('falls back to the family for a site the table does not name', () => {
    // 115 prominent landform feature, 419 prominent vegetation feature, 531 special
    // man-made feature: the standard's own "something the symbols do not cover", which a
    // description sheet names by family too.
    expect(wordFor('115')).toBe('landform');
    expect(wordFor('528')).toBe('manmade');
    expect(wordFor('531')).toBe('manmade');
  });

  it('gives one word to the symbols a circle cannot tell apart', () => {
    // A runnability scale is not an answer space. Each of these used to be either a code
    // the drill refused outright or a look-alike in `BLOCKING`.
    expect(['505', '506', '507', '508'].map(wordFor)).toEqual(['path', 'path', 'path', 'path']);
    expect(['406', '408', '410', '411'].map(wordFor)).toEqual(Array(4).fill('thicket'));
    expect(['401', '403'].map(wordFor)).toEqual(['open', 'open']);
    expect(['210', '211', '212'].map(wordFor)).toEqual(Array(3).fill('stonyGround'));
    expect(['201', '202'].map(wordFor)).toEqual(['cliff', 'cliff']);
    expect(['417', '418', '419'].map(wordFor)).toEqual(['tree', 'tree', 'tree']);
  });

  it('says nothing about the contours, the forest or the course', () => {
    for (const code of ['101', '102', '103', '405', '520', '707', '709']) {
      expect(wordFor(code), code).toBeUndefined();
    }
  });
});

describe('sites on a line', () => {
  it('offers a bend, and not a straight', () => {
    const path = ground({
      features: [line('505', [{ x: 0, y: 150 }, { x: 150, y: 150 }, { x: 220, y: 60 }])],
    });
    expect(kindsOf(path)).toEqual(['path']);
    expect(sitesOf(path, WHOLE, RADIUS)[0]).toMatchObject({ at: { x: 150, y: 150 }, where: 'bend' });

    // A circle halfway along an unbending line marks a length of path, not a place on it.
    expect(kindsOf(ground({
      features: [line('505', [{ x: 0, y: 150 }, { x: 150, y: 150 }, { x: 300, y: 150 }])],
    }))).toEqual([]);
  });

  it('finds a T and an X', () => {
    const across = line('505', [{ x: 0, y: 150 }, { x: 300, y: 150 }]);
    const tee = ground({ features: [across, line('506', [{ x: 150, y: 150 }, { x: 150, y: 300 }])] });
    const junctions = sitesOf(tee, WHOLE, RADIUS).filter((s) => s.where === 'junction');
    expect(junctions.map((s) => s.at)).toEqual([{ x: 150, y: 150 }]);

    const ex = ground({ features: [across, line('506', [{ x: 150, y: 0 }, { x: 150, y: 300 }])] });
    const crossings = sitesOf(ex, WHOLE, RADIUS).filter((s) => s.where === 'crossing');
    expect(crossings.map((s) => s.at)).toEqual([{ x: 150, y: 150 }]);
  });

  it('reads a fork onto a stream as two things in one ring', () => {
    // Both lines are named at the fork, so a circle there says path *and* stream and the
    // round would have two answers. A path onto a path is one word and stands.
    const stream = line('305', [{ x: 0, y: 150 }, { x: 300, y: 150 }]);
    const path = line('505', [{ x: 150, y: 150 }, { x: 150, y: 300 }]);
    expect(kindsOf(ground({ features: [stream, path] }))).toEqual([]);
  });

  it('takes a loose end, but not one on the edge of the drawing', () => {
    // The drawing here runs from x = 40 to x = 260: one end of the path is inside it and
    // the other is where the surveyor's sheet stopped.
    const map = ground({
      features: [
        line('505', [{ x: 40, y: 150 }, { x: 150, y: 150 }]),
        at('204', 40, 40), at('204', 260, 260),
      ],
    });
    const ends = sitesOf(map, WHOLE, RADIUS).filter((s) => s.where === 'end');
    expect(ends.map((s) => s.at)).toEqual([{ x: 150, y: 150 }]);
  });

  it('never offers the same place on one line twice', () => {
    // A bend and a loose end a step from the fork are one place, and the fork is what a
    // description sheet would name it by.
    const bent = line('505', [{ x: 140, y: 150 }, { x: 150, y: 150 }, { x: 160, y: 120 }]);
    const onto = line('506', [{ x: 160, y: 120 }, { x: 160, y: 260 }]);
    const sites = sitesOf(
      ground({ features: [bent, onto, at('204', 40, 40), at('204', 260, 260)] }),
      WHOLE,
      RADIUS,
    ).filter((s) => s.source === 'line:0');
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ where: 'junction', at: { x: 160, y: 120 } });
  });

  it('hangs the circle on the line it names', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        for (const site of generatedSites(seed, level)) {
          if (!['bend', 'junction', 'crossing', 'end'].includes(site.where)) continue;
          expect(clearanceFrom({ shape: site.shape, reach: 0 }, site.at)).toBeLessThan(0.001);
        }
      }),
      { numRuns: 10 },
    );
  });
});

describe('sites on an area', () => {
  it('takes the corners of the outline and never the middle', () => {
    const field = ground({ features: [area('401', box(100, 100, 100, 100))] });
    const sites = sitesOf(field, WHOLE, RADIUS);
    expect(sites.map((s) => s.where)).toEqual(['corner', 'corner', 'corner', 'corner']);
    expect(sites.map((s) => s.at)).toEqual(box(100, 100, 100, 100));
    // The middle of a meadow marks nothing a description sheet has a word for.
    expect(sites.some((s) => s.at.x === 150 && s.at.y === 150)).toBe(false);
  });

  it('takes the middle of a short side', () => {
    // A yard 70 m across: four corners, and four sides short enough for a middle.
    const ring = box(115, 115, 70, 70);
    const sites = sitesOf(ground({ features: [area('521', ring)] }), WHOLE, RADIUS);
    expect(sites.filter((s) => s.where === 'corner')).toHaveLength(4);
    expect(sites.filter((s) => s.where === 'side')).toHaveLength(4);
    for (const site of sites) {
      expect(clearanceFrom({ shape: site.shape, reach: 0 }, site.at)).toBeLessThan(0.001);
    }
  });

  it('counts the side from the last vertex back to the first', () => {
    // A ring is a list of vertices and is **closed** — `MapView` draws every one of them
    // with a `Z` — so the side that runs from the last back to the first is ink like the
    // other three, and a circle on it is a circle on the outline. Read as an open
    // polyline the ring loses that side entirely, which is how a site on it looked like a
    // site on nothing.
    const ring = box(115, 115, 70, 70);
    const middle = { x: 115, y: 150 };
    const sites = sitesOf(ground({ features: [area('521', ring)] }), WHOLE, RADIUS);
    const onClosingSide = sites.find(
      (s) => Math.hypot(s.at.x - middle.x, s.at.y - middle.y) < 0.001,
    );
    expect(onClosingSide?.where).toBe('side');
    expect(clearanceFrom({ shape: [...ring, ring[0]!], reach: 0 }, middle)).toBeLessThan(0.001);
    // The trap, stated: the same ring left open puts it 35 m from the nearest side.
    expect(clearanceFrom({ shape: ring, reach: 0 }, middle)).toBeGreaterThan(30);
  });

  it('does not let a wash under a ring block what is standing in it', () => {
    // Half the control circles on a real map have some green. An area's interior is not a
    // shadow, and its ground cover does not shadow a thing standing on it either.
    const wash = area('408', box(50, 50, 200, 200));
    const boulder = at('204', 150, 150);
    expect(kindsOf(ground({ features: [wash, boulder] }))).toContain('boulder');
    // ...and the boulder shadows the corner of the wash, because it is the more
    // particular of the two and a description sheet would name it.
    const corner = area('408', box(140, 140, 120, 120));
    const sites = sitesOf(ground({ features: [corner, at('204', 145, 145)] }), WHOLE, RADIUS);
    expect(sites.some((s) => s.kind === 'thicket' && s.at.x === 140 && s.at.y === 140)).toBe(false);
  });

  it('reads two kinds of cover meeting as two things', () => {
    const thicket = area('408', box(50, 100, 100, 100));
    const clearing = area('401', box(150, 100, 100, 100));
    // Their shared edge is where green meets yellow, and a ring on it is either.
    const sites = sitesOf(ground({ features: [thicket, clearing] }), WHOLE, RADIUS);
    expect(sites.every((s) => s.at.x !== 150)).toBe(true);
  });
});

describe('the impassable things', () => {
  it('are sites at their edge or their foot, like anything else', () => {
    // `barrier` is a route cost and `barrierStrict` is a sprint rule, and neither is asked
    // here or anywhere in this drill: a control at the foot of an impassable cliff or at
    // the corner of a building is ordinary in both disciplines. The four that carry the
    // flag on a forest map, each drawn as what it is.
    const cases: [IsomCode, ControlKind, Feature][] = [
      ['201', 'cliff', line('201', [{ x: 60, y: 150 }, { x: 150, y: 150 }, { x: 220, y: 90 }])],
      ['515', 'wall', line('515', [{ x: 60, y: 150 }, { x: 150, y: 150 }, { x: 220, y: 90 }])],
      ['521', 'building', area('521', box(115, 115, 70, 70))],
      ['301', 'pond', area('301', box(115, 115, 70, 70))],
    ];
    for (const [code, word, feature] of cases) {
      expect(semanticsOf(code)?.barrierStrict, code).toBe(true);
      const sites = sitesOf(ground({ features: [feature] }), WHOLE, RADIUS);
      expect(sites.length, code).toBeGreaterThan(0);
      expect(new Set(sites.map((s) => s.kind)), code).toEqual(new Set([word]));
      // On the thing itself, never in the middle of it.
      for (const site of sites) {
        expect(clearanceFrom({ shape: site.shape, reach: 0 }, site.at)).toBeLessThan(0.001);
      }
    }
  });
});

describe('sites on a point', () => {
  it('keeps the whole circle on the card', () => {
    expect(kindsOf(ground({ features: [at('204', 8, 150), at('417', 150, 150)] })))
      .toEqual(['tree']);
  });

  it('will not circle one of two things', () => {
    const near = (gap: number) =>
      kindsOf(ground({ features: [at('204', 150, 150), at('417', 150 + gap, 150)] }));
    expect(near(10)).toEqual([]);
    expect(near(60)).toEqual(['boulder', 'tree']);
  });

  it('lets two of a kind share a ring, because the answer is the kind', () => {
    expect(kindsOf(ground({ features: [point('boulder', 150, 150, 4), point('boulder', 158, 150, 4)] })))
      .toEqual(['boulder', 'boulder']);
  });

  it('lets two names of one thing share a ring too', () => {
    // 204 a boulder and 205 a large boulder: one word, so one answer.
    expect(kindsOf(ground({ features: [at('204', 150, 150), at('205', 158, 150)] })))
      .toEqual(['boulder', 'boulder']);
  });
});

describe('sites on the ground itself', () => {
  it('drops a landform the ground does not show', () => {
    const hill = (amplitude: number): GeneratedMap =>
      ground({
        landforms: [
          { kind: 'hill', x: 150, y: 150, radius: 45, amplitude, rotation: 0, elongation: 1 },
        ],
      });
    // 20 m of hill over a 45 m radius stands well clear of ground falling 0.06 m/m.
    expect(kindsOf(hill(20))).toEqual(['hill']);
    // 3 m of it is under one contour interval, and the slope swallows it.
    expect(kindsOf(hill(3))).toEqual([]);
  });

  it('marks the top of a rise, not the middle of the bump under it', () => {
    // The ground here rises towards +x, so the top of a wide bump laid on it is uphill of
    // the bump's own middle — by more than the circle would forgive.
    const site = sitesOf(
      ground({
        landforms: [
          { kind: 'hill', x: 150, y: 150, radius: 100, amplitude: 25, rotation: 0, elongation: 1 },
        ],
      }),
      WHOLE,
      RADIUS,
    )[0]!;
    expect(site.at.x).toBeGreaterThan(150);
    expect(site.at.y).toBe(150);
  });

  it('reads a long form along its length', () => {
    const spur = ground({
      landforms: [
        { kind: 'spur', x: 150, y: 150, radius: 30, amplitude: 20, rotation: 0, elongation: 3 },
      ],
    });
    const sites = sitesOf(spur, WHOLE, RADIUS);
    expect(sites.length).toBeGreaterThan(1);
    expect(new Set(sites.map((s) => s.kind))).toEqual(new Set(['spur']));
  });

  it('says knoll for a knoll on a hill', () => {
    // `placePoints` puts knolls on `ground.maxima`, and a surveyed knoll is drawn on a
    // rise for the same reason a real one is. The drawn symbol is the answer; the hill it
    // stands on is the reason it is there.
    const map = ground({
      landforms: [
        { kind: 'hill', x: 150, y: 150, radius: 45, amplitude: 20, rotation: 0, elongation: 1 },
      ],
      features: [at('109', 150, 150)],
    });
    expect(kindsOf(map)).toEqual(['knoll']);

    // A boulder is **not** relief-bound: it stands on the hilltop rather than being it,
    // so a ring holding both still has two answers in it.
    const withBoulder = ground({
      landforms: [
        { kind: 'hill', x: 150, y: 150, radius: 45, amplitude: 20, rotation: 0, elongation: 1 },
      ],
      features: [at('204', 150, 150)],
    });
    expect(kindsOf(withBoulder)).toEqual([]);
  });
});

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: 1, max: 10 });

/** The sites of one window of generated ground, at the radius that level would use. */
function generatedSites(seed: number, level: number) {
  const rng = seeded(seed);
  const picked = new GeneratedProvider().pick(rng, requirementFor(level));
  return sitesOf(picked.map, picked.crop, paramsFor(level).size * CIRCLE_FRACTION);
}

describe('the ring rule', () => {
  it('leaves exactly one word in every ring', () => {
    // The whole of what makes a round answerable, asked of the map directly rather than
    // through the list `sitesOf` built. Ground cover is not in it — a wash of green under
    // a circle is the ground, not the thing circled — and neither is a form of the ground
    // under the symbol that names it.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const rng = seeded(seed);
        const picked = new GeneratedProvider().pick(rng, requirementFor(level));
        const radius = paramsFor(level).size * CIRCLE_FRACTION;
        const sites = sitesOf(picked.map, picked.crop, radius);
        for (const site of sites) {
          const words = new Set<ControlKind>([site.kind]);
          for (const feature of picked.map.features) {
            const word = wordFor(feature.code);
            const semantics = semanticsOf(feature.code);
            if (!word || word === site.kind) continue;
            // The two exemptions, stated here as the rule and not as the code. Cover is an
            // area of it, or either boundary line — a cover area's edge drawn a second
            // time.
            const cover = GROUND_COVER.has(word)
              && (feature.geometry.kind === 'polygon' || word === 'vegetationBoundary');
            if (cover) continue;
            if (feature.geometry.kind === 'point' && semantics?.reliefBound) continue;
            // Every ring, **closed**: `MapView` draws each one with a `Z`, so the side
            // from the last vertex back to the first is ink like every other side. A ring
            // measured as an open polyline hides both a site on that side and a shadow
            // cast from it.
            const shapes =
              feature.geometry.kind === 'point' ? [[feature.geometry.at]]
              : feature.geometry.kind === 'polyline' ? [feature.geometry.points]
              : feature.geometry.rings.map((ring) => {
                  const first = ring[0]!;
                  const last = ring[ring.length - 1]!;
                  return first.x === last.x && first.y === last.y ? ring : [...ring, first];
                });
            const near = shapes.some((shape) => clearanceFrom({ shape, reach: 0 }, site.at) < radius);
            if (near) words.add(word);
          }
          expect([...words]).toEqual([site.kind]);
        }
      }),
      { numRuns: 12 },
    );
  });

  it('keeps every site clear of the edge of the card', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const rng = seeded(seed);
        const picked = new GeneratedProvider().pick(rng, requirementFor(level));
        const radius = paramsFor(level).size * CIRCLE_FRACTION;
        const { crop } = picked;
        for (const site of sitesOf(picked.map, crop, radius)) {
          expect(site.at.x).toBeGreaterThanOrEqual(crop.x + radius);
          expect(site.at.y).toBeGreaterThanOrEqual(crop.y + radius);
          expect(site.at.x).toBeLessThanOrEqual(crop.x + crop.size - radius);
          expect(site.at.y).toBeLessThanOrEqual(crop.y + crop.size - radius);
        }
      }),
      { numRuns: 10 },
    );
  });
});

/** The cover words, restated for the property above rather than imported: a test that
 *  reads the rule's own table cannot catch the rule's table being wrong. */
const GROUND_COVER = new Set<ControlKind>([
  'open', 'thicket', 'cultivated', 'brokenGround', 'boulderField',
  'stonyGround', 'sandyGround', 'rock', 'marsh', 'paved', 'vegetationBoundary',
]);
