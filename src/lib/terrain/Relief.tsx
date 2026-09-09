import { useEffect, useRef } from 'react';
import type { Relief as ReliefField } from './relief.ts';

/**
 * The same ground, shaded.
 *
 * Canvas, not SVG — this is the one thing in the app that is genuinely per-pixel. It is
 * also the only place a drill's *appearance* carries information, so the shading is fixed
 * rather than normalised per terrain: two reliefs have to be comparable, and stretching
 * each one to its own range would flatten exactly the difference the drill is asking
 * about.
 */
const RESOLUTION = 148;

/** Vertical exaggeration. Orienteering relief is subtle and reads as flat unless lifted. */
const Z_SCALE = 2.6;

/** Light from the north-west, the cartographic convention. */
const LIGHT = { x: -0.6, y: -0.6, z: 0.53 };
const AMBIENT = 0.34;

export interface ReliefProps {
  readonly relief: ReliefField;
  readonly className?: string;
}

export default function Relief({ relief, className }: ReliefProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const n = RESOLUTION;
    const grid = relief.sampleGrid(n);
    const step = grid.size / n;
    const image = context.createImageData(n, n);
    const at = (i: number, j: number) => grid.values[j * (n + 1) + i]!;

    const light = normalise(LIGHT);

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // Central differences, clamped at the border rather than wrapped: a wrapped
        // gradient invents a cliff along two edges of every map.
        const iL = Math.max(0, i - 1);
        const iR = Math.min(n, i + 1);
        const jU = Math.max(0, j - 1);
        const jD = Math.min(n, j + 1);
        const dzdx = ((at(iR, j) - at(iL, j)) / ((iR - iL) * step)) * Z_SCALE;
        const dzdy = ((at(i, jD) - at(i, jU)) / ((jD - jU) * step)) * Z_SCALE;

        const normal = normalise({ x: -dzdx, y: -dzdy, z: 1 });
        const lambert = Math.max(0, normal.x * light.x + normal.y * light.y + normal.z * light.z);
        const shade = AMBIENT + (1 - AMBIENT) * lambert;

        // A warm grey rather than neutral: it reads as ground, and keeps the relief
        // visually distinct from the brown-on-white contour card beside it.
        const value = Math.round(255 * shade);
        const offset = (j * n + i) * 4;
        image.data[offset] = Math.min(255, Math.round(value * 1.02));
        image.data[offset + 1] = value;
        image.data[offset + 2] = Math.round(value * 0.93);
        image.data[offset + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);
  }, [relief]);

  return <canvas ref={ref} width={RESOLUTION} height={RESOLUTION} className={className} />;
}

function normalise(v: { x: number; y: number; z: number }) {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
