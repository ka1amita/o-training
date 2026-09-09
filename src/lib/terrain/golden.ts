import type { Terrain } from './terrain.ts';

/**
 * A map reduced to **the generator's decisions**, for the golden hashes.
 *
 * The goldens exist to pin generation: one seed, one map, one hash. They are not there to
 * pin the shape of the types the engine happens to carry those decisions in — the engine
 * is being taken apart into a source-neutral `OMap`, and a hash over the live objects
 * would have to be re-pinned at every step of that, which would destroy the one thing the
 * hash is for. Re-pinning is then indistinguishable from having broken generation.
 *
 * So the goldens hash this projection instead: where each landform sits, what every
 * feature is and where. It changes only when the generator's answers change. Field order
 * is part of the hash — `hashJson` serialises in insertion order — so this builds each
 * object explicitly rather than spreading whatever the type currently holds.
 *
 * See also `hashJson`, which quantises to six decimals so a hash pins the generator and
 * not the engine's last float bit.
 */
export function goldenMap(t: Terrain): unknown {
  return {
    size: t.size,
    tilt: { x: t.tilt.x, y: t.tilt.y },
    noiseSeed: t.noiseSeed,
    landforms: t.landforms.map((f) => ({
      kind: f.kind,
      x: f.x,
      y: f.y,
      radius: f.radius,
      amplitude: f.amplitude,
      rotation: f.rotation,
      elongation: f.elongation,
    })),
    points: t.points.map((f) => ({
      kind: f.kind, code: f.code, x: f.x, y: f.y, size: f.size,
    })),
    lines: t.lines.map((l) => ({
      kind: l.kind, code: l.code, points: l.points.map((p) => ({ x: p.x, y: p.y })),
    })),
    areas: t.areas.map((a) => ({
      kind: a.kind, code: a.code, x: a.x, y: a.y, rx: a.rx, ry: a.ry, rotation: a.rotation,
    })),
  };
}
