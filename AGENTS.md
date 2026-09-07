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
3. **Reducers.** `session.ts`, each drill's interaction rules, and the netcode take
   timestamps as event fields, so tests need no fake timers.

   A drill's tap rules go in its own `state.ts` as `(round, state, event) => state`, not
   in `Play`. Match Madness had them in the component first, reading `selected` and
   `matched` out of a closure — two taps landing before a re-render both saw the same
   stale state and the round could not finish. A reducer cannot have that bug, and
   `useReducer` queues dispatches so a batch resolves in order.
4. **Not tested: rendering.** Checked by eye. Safe only because of the rule above.

## Non-obvious

- **Hash routing.** Static hosting; a path-routed reload on GitHub Pages is a 404.
- **`tsconfig` has no `baseUrl`** — TS 7 removed it. Path aliases are relative.
- **`store.ts` treats a malformed record as no progress** rather than throwing. Storage
  gets cleared and older builds wrote other shapes; a training screen must still open.
- **Session response times are medians, not means.** One round where the phone was put
  down would otherwise hide the trend.
- **The staircase resets its run on advancing**, so six correct is two levels, not four.
- **`DrillPage` keys `Play` on the round index.** Play holds per-round state in the
  reducer, and without a fresh instance the second round starts already finished.
- **Icons are generated** by `node scripts/make-icons.mjs` — no image library on the
  machine and none worth adding for two files. Symbols likewise, by
  `node scripts/build-symbols.mjs`; both outputs are committed, so neither package is a
  runtime dependency.
- **Only IOF column D is used** — the feature column. Columns C/E/F/G are modifiers and
  directions ("North-east side"), which would flood the pool with near-identical glyphs.
  Duplicate English names are dropped: two symbols sharing a meaning is the one thing
  that makes a round unanswerable.
- **Same-category rounds are the real difficulty knob** above level 3. More pairs is only
  more scanning; spur against re-entrant is the discrimination the sport asks for. The
  grouping comes from the IOF numbering, so it is read from data, not maintained by hand.
- **A Dobble deck is a finite projective plane, and the order must be prime.** The
  construction in `dohledavka/deck.ts` uses arithmetic mod the order; a prime *power* like
  4 or 9 has a plane but not one this finds. Measured: at order 4, 16 of 210 card pairs
  share no symbol and 16 share two. That is a card with no answer or two, not a crash,
  so `buildDeck` refuses rather than trusting the caller.
- **Dobble symbol size is derived from the layout geometry, never chosen.** `layoutFor`
  solves for the largest scale that cannot overlap at the worst combination of jitters.
  Hand-picked sizes were tried first and the property test rejected them within ten cases.
- **Only taps cross the wire.** Both peers derive the deck from the seed in `hello`, which
  is why the golden determinism tests are load-bearing: output drifting between builds
  would desynchronise a game with nothing on screen to say so.
- **The host decides every outcome.** Without one authority both peers see their own tap
  as first and the screens disagree. The joiner pays a little latency for that.
- **A joiner must return its answer before its data channel exists.** The channel only
  opens once the host has the answer, so waiting for it first is a deadlock that looks
  exactly like a peer who never replied. `makeTransport` attaches the channel late.
- **`trimSdp`'s `(:|$)` is load-bearing** — without it `extmap` also matches the
  session-level `a=extmap-allow-mixed`, which is not an extmap at all.
- **Split screen is the same rules, not a second implementation.** `found` carries an
  optional `by`, so the host awards either half; that is the whole cost of the fallback.
- **STUN cannot fix symmetric or carrier-grade NAT** — only a TURN relay can, and there is
  no server. So the connection must time out and offer split screen, never hang.

## Verify

```bash
npm run typecheck && npm test && npm run build
npm run preview      # PWA behaviour needs the built bundle, not the dev server
```
