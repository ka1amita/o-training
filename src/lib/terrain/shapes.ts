import type { AreaFeature, Vec } from './terrain.ts';

/**
 * Irregular outlines for area features.
 *
 * An ellipse is the single most recognisable tell that nobody surveyed this. Real marsh
 * and vegetation boundaries wander, and an orienteer reads that wandering — the shape of
 * a green edge is what tells you which green edge it is.
 *
 * The wander is deterministic, and the seed is **the feature's shape, never its
 * position**. `perturb` moves an area; if `x` and `y` fed the hash, moving it would also
 * reshape it, and a map-memory distractor would differ by far more than the `distance`
 * its level asked for. Silently easier rounds are worse than obvious ones.
 */

/** FNV-1a over the shape fields, quantised so float noise cannot flip the hash. */
function shapeSeed(area: AreaFeature): number {
  const parts = [
    area.kind,
    Math.round(area.rx * 64),
    Math.round(area.ry * 64),
    Math.round(area.rotation * 4096),
  ].join(':');
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Three harmonics: one lobe, one bay, one ripple. More reads as a snowflake. */
const HARMONICS: readonly { readonly k: number; readonly amplitude: number }[] = [
  { k: 2, amplitude: 0.16 },
  { k: 3, amplitude: 0.1 },
  { k: 5, amplitude: 0.055 },
];

const VERTICES = 28;

/**
 * A closed loop of world points around the feature.
 *
 * Radii stay within about ±30% of the ellipse, so the area still covers roughly the
 * ground `rx`/`ry` claim and the culling box in `MapView` remains sound.
 */
export function areaOutline(area: AreaFeature): Vec[] {
  const seed = shapeSeed(area);
  // Phases from disjoint bit fields of one hash: three draws, no generator to thread.
  const phases = HARMONICS.map((_, i) => (((seed >>> (i * 9)) & 0x1ff) / 0x200) * 2 * Math.PI);

  const cos = Math.cos(area.rotation);
  const sin = Math.sin(area.rotation);
  const points: Vec[] = [];

  for (let i = 0; i < VERTICES; i++) {
    const t = (i / VERTICES) * 2 * Math.PI;
    let r = 1;
    for (let h = 0; h < HARMONICS.length; h++) {
      const { k, amplitude } = HARMONICS[h]!;
      r += amplitude * Math.sin(k * t + phases[h]!);
    }
    const lx = Math.cos(t) * area.rx * r;
    const ly = Math.sin(t) * area.ry * r;
    points.push({ x: area.x + lx * cos - ly * sin, y: area.y + lx * sin + ly * cos });
  }
  return points;
}

/** The widest the outline can stray from the centre, for culling. */
export const OUTLINE_SLACK = 1 + HARMONICS.reduce((s, h) => s + h.amplitude, 0);
