# OB Training

Client-only PWA. No backend, no accounts, no personal data. React 19 + Vite 8 + TS 7 +
Tailwind 4, static output.

## The one rule

**An answer is derived from a round's structure, never from what was rendered.** If
`score()` ever needs to read a canvas, that is the bug. Everything below follows from it.

## The drill contract — `src/drills/types.ts`

`generate` / `wellFormed` / `score` are pure; `Play` is the only part that touches the DOM.
Adding a drill is one directory under `src/drills/` and one entry in `src/drills/index.ts`.
Nothing else in the app enumerates drills, and `DrillPage` never learns what a drill is.

`generate` takes an `Rng` and never reaches for `Math.random` or `Date.now()`. Two things
depend on that: golden tests, and P2P Dohledávka, where both peers derive the same deck
from a shared seed instead of sending one over the wire.

## Testing

Four layers, in `src/**/*.test.ts`:

1. **Well-formedness properties** (`fast-check`). The invariant that matters everywhere is
   **exactly one correct answer exists** — a round with two is unfair and invisible while
   playing. `wellFormed()` is also checked at runtime in dev.
2. **Golden determinism.** One seed, one round, pinned by hash.
3. **Reducers.** `session.ts` and the netcode take timestamps as event fields, so tests
   need no fake timers.
4. **Not tested: rendering.** Checked by eye. Safe only because of the rule above.

## Non-obvious

- **Hash routing.** Static hosting; a path-routed reload on GitHub Pages is a 404.
- **`tsconfig` has no `baseUrl`** — TS 7 removed it. Path aliases are relative.
- **`store.ts` treats a malformed record as no progress** rather than throwing. Storage
  gets cleared and older builds wrote other shapes; a training screen must still open.
- **Session response times are medians, not means.** One round where the phone was put
  down would otherwise hide the trend.
- **The staircase resets its run on advancing**, so six correct is two levels, not four.
- **Icons are generated** by `node scripts/make-icons.mjs` — no image library on the
  machine and none worth adding for two files.

## Verify

```bash
npm run typecheck && npm test && npm run build
npm run preview      # PWA behaviour needs the built bundle, not the dev server
```
