# OB Training

Off-forest orienteering drills — the parts that are not running: symbols, map memory, and
reading relief off contours.

Everything is generated on your device. There is no account, no server, and no analytics.

## Run it

```bash
npm install && npm run dev
```

## Drills

| | |
|---|---|
| Match Madness | IOF control-description symbols against the clock |
| Dohledávka | Dobble: two cards, one shared symbol, first tap wins. Two players, on one device or over a link |
| Mapová dohledávka | The same game on two maps: several controls a card, one kind of feature circled on both |
| Posunuté pexeso | Pairs are two offset crops of one map sharing a control. Match by recognising the ground |
| Contours → relief | Read the brown lines, then pick the ground they describe |
| Map memory | A map extract, briefly. Then pick the one you saw |

Difficulty follows a 3-down-1-up staircase: three correct moves you up, one miss moves you
down. It settles where you are right about 79% of the time.

Progress tracks **median response time per session** — the number a 2026 study on the
Danish elite squad found falling 27% over six weeks of this kind of work, steeply through
about session seven and then flattening.

## Deploy

Live at <https://www.matejkala.com/ob-training/>.

(The user site's custom domain applies to project pages too, so
`ka1amita.github.io/ob-training/` redirects there. The `/ob-training/` subpath — which
`base` has to match — is the same either way.)

Pushing to `main` is the deploy. `.github/workflows/ci.yml` runs typecheck, tests, and the
`base=/ob-training/` build; only if all three are green does it force-push that same
`dist/` to the `gh-pages` branch. The deploy job publishes the **artifact the checks ran
against** rather than rebuilding — otherwise "green" would be a claim about a different
build. Pull requests run the checks and stop there.

The job declares a `production` environment, so Actions keeps the deployment history and
the live URL, and a required reviewer can be added there later to gate releases.

Manual escape hatch, unchanged:

```bash
npm run deploy
```

Builds and force-pushes `dist/` to `gh-pages` from your machine. Source stays on `main`;
that branch only ever holds the current build, one commit deep.

Pushing anything under `.github/workflows/` needs the `workflow` token scope when git is
authenticating over HTTPS with an OAuth token. `origin` here is SSH, which is not subject
to it; if you ever switch to HTTPS: `gh auth refresh -s workflow`.

## Privacy

Stored on your device: a level per drill and a list of finished sessions
(`{timestamp, responseMs, correct}`). Nothing else — no name, no identifier, no telemetry.
Erase it all from the Progress screen.

**One exception worth knowing:** playing Dohledávka over a link opens a direct
peer-to-peer connection, and that **discloses your IP address to the other player**.
Nothing is stored and nothing passes through a server — that is inherent to a serverless
connection, not a choice made here. Same-device split screen has no such caveat.

Some networks — mobile data especially — will not allow a direct connection at all, and
fixing that needs a relay server this app does not have. It says so and offers the
same-device game instead.

## Licence note

Control-description symbols come from
[`svg-control-descriptions`](https://github.com/perliedman/svg-control-descriptions),
extracted from Purple Pen. Its own README calls the licensing unclear.
