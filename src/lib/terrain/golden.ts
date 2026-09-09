import { areasOf, linesOf, pointsOf, positionOf, type OMap } from './omap.ts';
import { AnalyticRelief } from './relief.ts';

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
export function goldenMap(map: OMap): unknown {
  // Only the analytic relief has parameters to pin. An imported one is pinned by the
  // bundle id it came from, which is a hash already.
  const relief = map.relief instanceof AnalyticRelief ? map.relief : null;
  return {
    size: map.width,
    tilt: relief ? { x: relief.tilt.x, y: relief.tilt.y } : null,
    noiseSeed: relief ? relief.noiseSeed : null,
    landforms: (relief?.landforms ?? []).map((f) => ({
      kind: f.kind,
      x: f.x,
      y: f.y,
      radius: f.radius,
      amplitude: f.amplitude,
      rotation: f.rotation,
      elongation: f.elongation,
    })),
    points: pointsOf(map).map((f) => {
      const at = positionOf(f);
      return { kind: f.kind, code: f.code, x: at.x, y: at.y, size: f.size };
    }),
    lines: linesOf(map).map((l) => ({
      kind: l.kind,
      code: l.code,
      points: l.geometry.kind === 'polyline' ? l.geometry.points.map((p) => ({ x: p.x, y: p.y })) : [],
    })),
    areas: areasOf(map).map((a) => ({
      kind: a.kind,
      code: a.code,
      x: a.shape?.x,
      y: a.shape?.y,
      rx: a.shape?.rx,
      ry: a.shape?.ry,
      rotation: a.shape?.rotation,
    })),
  };
}
