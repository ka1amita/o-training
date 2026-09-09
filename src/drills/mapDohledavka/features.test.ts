import { describe, it, expect } from 'vitest';
import type { Terrain } from '@/lib/terrain/terrain.ts';
import { sitesOf } from './features.ts';

/** A bare 300 m map. `noiseSeed` 0 is the documented "no micro-relief" case in `noise.ts`. */
const ground = (over: Partial<Terrain> = {}): Terrain => ({
  size: 300,
  tilt: { x: 0.06, y: 0 },
  noiseSeed: 0,
  landforms: [],
  points: [],
  lines: [],
  areas: [],
  ...over,
});

const RADIUS = 15;
const kindsOf = (terrain: Terrain) => sitesOf(terrain, RADIUS).map((s) => s.kind);

describe('sites', () => {
  it('offers a bend on a path, and not its ends', () => {
    const path = ground({
      lines: [{ kind: 'path', points: [{ x: 0, y: 150 }, { x: 150, y: 150 }, { x: 220, y: 60 }] }],
    });
    expect(kindsOf(path)).toEqual(['path']);
    expect(sitesOf(path, RADIUS)[0]!.at).toEqual({ x: 150, y: 150 });
  });

  it('will not hang a control on a straight', () => {
    // A circle halfway along an unbending line marks a length of path, not a place.
    expect(kindsOf(ground({
      lines: [{ kind: 'path', points: [{ x: 0, y: 150 }, { x: 150, y: 150 }, { x: 300, y: 150 }] }],
    }))).toEqual([]);
  });

  it('lets a ride spoil a site it could never hold', () => {
    const bend = { kind: 'path', points: [{ x: 0, y: 150 }, { x: 150, y: 150 }, { x: 220, y: 60 }] } as const;
    const ride = { kind: 'ride', points: [{ x: 140, y: 0 }, { x: 140, y: 300 }] } as const;
    expect(kindsOf(ground({ lines: [bend] }))).toEqual(['path']);
    // The ride is never an answer, and it is still black across the middle of the ring.
    expect(kindsOf(ground({ lines: [bend, ride] }))).toEqual([]);
  });

  it('drops a landform the ground does not show', () => {
    const hill = (amplitude: number): Terrain =>
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
      RADIUS,
    )[0]!;
    expect(site.at.x).toBeGreaterThan(150);
    expect(site.at.y).toBe(150);
  });

  it('keeps the whole circle on the card', () => {
    const edge = ground({
      points: [
        { kind: 'boulder', x: 8, y: 150, size: 4 },
        { kind: 'tree', x: 150, y: 150, size: 4 },
      ],
    });
    expect(kindsOf(edge)).toEqual(['tree']);
  });

  it('will not circle one of two things', () => {
    const near = (gap: number) =>
      kindsOf(ground({
        points: [
          { kind: 'boulder', x: 150, y: 150, size: 4 },
          { kind: 'tree', x: 150 + gap, y: 150, size: 4 },
        ],
      }));
    expect(near(10)).toEqual([]);
    expect(near(60)).toEqual(['boulder', 'tree']);
  });

  it('lets two of a kind share a ring, because the answer is the kind', () => {
    expect(kindsOf(ground({
      points: [
        { kind: 'boulder', x: 150, y: 150, size: 4 },
        { kind: 'boulder', x: 158, y: 150, size: 4 },
      ],
    }))).toEqual(['boulder', 'boulder']);
  });
});
