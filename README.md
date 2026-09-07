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
| Dohledávka | Dobble: two cards, one shared symbol, first tap wins |
| Posunuté pexeso | Pairs are two offset crops of one map sharing a control feature |
| Contours → relief | Pick the hillshade the contours describe |
| Map memory | A map crop, briefly, then four candidates |

Difficulty follows a 3-down-1-up staircase: three correct moves you up, one miss moves you
down. It settles where you are right about 79% of the time.

## Privacy

Stored on your device: a level per drill and a list of finished sessions
(`{timestamp, responseMs, correct}`). Nothing else — no name, no identifier, no telemetry.
Erase it all from the Progress screen.

**One exception worth knowing:** playing Dohledávka against someone opens a direct
peer-to-peer connection, and that **discloses your IP address to the other player**.
Nothing is stored and nothing passes through a server — that is inherent to a serverless
connection, not a choice made here. Same-device split screen has no such caveat.

## Licence note

Control-description symbols come from
[`svg-control-descriptions`](https://github.com/perliedman/svg-control-descriptions),
extracted from Purple Pen. Its own README calls the licensing unclear.
