/**
 * Micro-relief: the small, coherent wander real ground has and a sum of smooth bumps
 * does not.
 *
 * Contours traced from four analytic bumps come out as clean nested ovals, and an
 * orienteer reads that as a diagram rather than a map. A metre of coherent noise is
 * enough to make a contour *behave* like a surveyed line without changing what it says.
 *
 * ## Why this cannot be seeded per sibling
 *
 * The noise is a function of world position and one seed carried on the terrain, and
 * `perturb` copies that seed unchanged. Siblings therefore share the noise exactly, and
 * `maxHeightDifference` between them stays zero everywhere the moved landform does not
 * reach — which is the whole point of giving the bumps compact support. Noise drawn from
 * the `Rng` during generation would differ between siblings and make every distractor
 * differ everywhere, which is the opposite of the drill.
 */

/** Integer hash to a float in [0, 1). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x85ebca6b) ^ seed) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 0x1_0000_0000;
}

/** Smoothstep, so the lattice does not show as a grid of creases. */
const ease = (t: number): number => t * t * (3 - 2 * t);

/** One octave of value noise in [-1, 1]. */
function octave(seed: number, x: number, y: number, wavelength: number): number {
  const u = x / wavelength;
  const v = y / wavelength;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = ease(u - i);
  const fv = ease(v - j);
  const a = hash2(i, j, seed);
  const b = hash2(i + 1, j, seed);
  const c = hash2(i, j + 1, seed);
  const d = hash2(i + 1, j + 1, seed);
  const top = a + (b - a) * fu;
  const bottom = c + (d - c) * fu;
  return 2 * (top + (bottom - top) * fv) - 1;
}

/**
 * Two octaves, in metres.
 *
 * Amplitudes are deliberately small against the 5 m contour interval. The gradient they
 * add — about 0.04 m/m — has to stay under the regional tilt, or the background fills
 * with noise loops instead of the long parallel contours gentle ground actually shows.
 */
const OCTAVES: readonly { readonly wavelength: number; readonly amplitude: number }[] = [
  { wavelength: 60, amplitude: 1 },
  { wavelength: 28, amplitude: 0.3 },
];

/**
 * Seed 0 means **no micro-relief**.
 *
 * The contour tracer's own tests need exact analytic geometry — a ring around a lone hill
 * has to be a ring — and there is no other way to ask for a smooth field. `generateTerrain`
 * sets the low bit of its seed so it can never land here by accident.
 */
export function microRelief(seed: number, x: number, y: number): number {
  if (seed === 0) return 0;
  let h = 0;
  for (let i = 0; i < OCTAVES.length; i++) {
    const { wavelength, amplitude } = OCTAVES[i]!;
    // A different seed per octave, or the two lattices line up at shared multiples.
    h += amplitude * octave(seed + i * 0x9e37, x, y, wavelength);
  }
  return h;
}
