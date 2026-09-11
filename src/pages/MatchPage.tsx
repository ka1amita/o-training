import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import { CardView } from '@/drills/dohledavka/Cards.tsx';
import { dohledavka } from '@/drills/dohledavka/drill.ts';
import { bundleUrl, loadLibrary } from '@/lib/maps/library.ts';
import { bundlesFor, loadPolicy, providerFor } from '@/lib/maps/policy.ts';
import { GeneratedProvider } from '@/lib/maps/provider.ts';
import { deriveSeed, seeded } from '@/lib/rng.ts';
import { idb } from '@/lib/store.ts';
import { helloFor, hostState, joinerState, peerReduce, type PeerEvent, type PeerState } from '@/net/peer.ts';
import { decode, encode, type Side } from '@/net/protocol.ts';
import type { Transport } from '@/net/transport.ts';
import { createHost, joinWithCode, CONNECT_TIMEOUT_MS, type HostSide, type JoinerSide } from '@/net/webrtc.ts';

const ROUNDS = 10;
const LEVEL = 5;
/**
 * How long the decided round stays up — the shared symbol marked on both cards — before
 * the host moves on.
 *
 * The single-player drill waits for a tap on Continue; a match cannot. Two players are
 * looking at two screens and neither of them owns the round, so a confirmation would be
 * one player holding the other up, and one who never taps would end the game. The host
 * times it instead, sends the same `next` it always sent, and both screens move together
 * — the joiner's reveal is this window plus the hop, which is the latency it already pays
 * for every outcome.
 *
 * One constant, and it is short: long enough to see which symbol it was, not long enough
 * to be a pause between rounds.
 */
const REVEAL_MS = 1500;

type Mode = 'lobby' | 'split' | 'host' | 'join';

export default function MatchPage() {
  const { code } = useParams<{ code?: string }>();
  const [mode, setMode] = useState<Mode>(code ? 'join' : 'lobby');
  const providerId = useProviderId();
  const leave = () => setMode('lobby');

  if (mode === 'lobby') return <Lobby onPick={setMode} />;
  // Which maps this device holds has to be known before the handshake, not during it: the
  // id goes out in `hello`, and a game that started before it was read would announce the
  // wrong one. It is one IndexedDB read for the default policy and nothing else.
  if (providerId === null) return <Waiting note="Preparing…" />;
  if (mode === 'split') return <SplitMatch providerId={providerId} onLeave={leave} />;
  if (mode === 'host') return <HostFlow providerId={providerId} onLeave={leave} />;
  return <JoinFlow providerId={providerId} offerCode={code} onLeave={leave} />;
}

/**
 * This device's `MapProvider.id`, from its stored policy.
 *
 * Bundles are loaded because the id of a library is the content hashes of the maps in it —
 * that is what makes "we hold the same maps" a comparison rather than a hope. Cache-first,
 * and skipped outright for the default policy, so the common case touches no network at
 * all. Dohledavka draws symbols and uses none of it; this is the groundwork §5.2 asks for.
 */
function useProviderId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const policy = await loadPolicy(idb);
      const names = bundlesFor(policy);
      const maps = names.length === 0 ? [] : await loadLibrary(names.map(bundleUrl), fetch, idb);
      if (live) setId(providerFor(policy, maps).id);
    })();
    return () => {
      live = false;
    };
  }, []);
  return id;
}

function Lobby({ onPick }: { onPick: (mode: Mode) => void }) {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <h2 className="m-0 text-base font-semibold">Dohledavka &middot; two players</h2>
      <p className="m-0 text-sm text-muted">
        Both players see the same two cards. They share exactly one symbol &mdash; first to
        tap it takes the round.
      </p>
      <Choice title="Same device" note="Phone flat on the table, one half each." onClick={() => onPick('split')} />
      <Choice title="Host online" note="Send a link to the other player." onClick={() => onPick('host')} />
      <Choice title="Join online" note="Open a link you were sent, or paste the code." onClick={() => onPick('join')} />
      <Link href="/" className="pt-2 text-center text-sm text-muted no-underline">Back</Link>
    </div>
  );
}

function Choice({ title, note, onClick }: { title: string; note: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-line bg-ink-soft px-4 py-4 text-left"
    >
      <span className="block font-semibold">{title}</span>
      <span className="mt-1 block text-sm text-muted">{note}</span>
    </button>
  );
}

/**
 * Wires the pure game rules to a transport.
 *
 * The current state is held in a ref as well as in React state so `dispatch` is stable
 * and never reduces from a stale value — two taps landing in one tick is the ordinary
 * case in a game about tapping fast.
 */
function useMatch(initial: PeerState, transport: Transport | null) {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);

  const dispatch = useCallback(
    (event: PeerEvent) => {
      const [next, outgoing] = peerReduce(ref.current, event);
      ref.current = next;
      setState(next);
      for (const message of outgoing) transport?.send(encode(message));
    },
    [transport],
  );

  useEffect(() => {
    if (!transport) return;
    return transport.onMessage((raw) => {
      const message = decode(raw);
      // A message that does not parse is dropped: a peer on an old build costs one lost
      // tap, not a crash on somebody's phone.
      if (message) dispatch({ type: 'received', message });
    });
  }, [transport, dispatch]);

  return [state, dispatch] as const;
}

/** Both peers derive the round from the shared seed; nothing about it crosses the wire. */
function useRound(state: PeerState) {
  return useMemo(
    () =>
      state.started
        ? dohledavka.generate(
            seeded(deriveSeed(state.seed, state.round)),
            state.level,
            // Dohledavka draws symbols, not ground, and ignores this.
            { maps: new GeneratedProvider() },
          )
        : null,
    [state.started, state.seed, state.round, state.level],
  );
}

function Scoreboard({ state, youAre }: { state: PeerState; youAre: Side | 'both' }) {
  const label = (side: Side) =>
    youAre === 'both' ? (side === 'host' ? 'P1' : 'P2') : side === youAre ? 'You' : 'Them';
  return (
    <div className="flex items-center justify-center gap-4 text-sm tabular-nums">
      <span className={state.winner === 'host' ? 'text-flag' : ''}>
        {label('host')} {state.scores.host}
      </span>
      <span className="text-muted">
        {Math.min(state.round + 1, state.rounds)}/{state.rounds}
      </span>
      <span className={state.winner === 'joiner' ? 'text-flag' : ''}>
        {label('joiner')} {state.scores.joiner}
      </span>
    </div>
  );
}

function Over({ state, youAre, onLeave }: { state: PeerState; youAre: Side | 'both'; onLeave: () => void }) {
  const { host, joiner } = state.scores;
  const verdict =
    host === joiner ? 'Draw' : youAre === 'both'
      ? `${host > joiner ? 'P1' : 'P2'} wins`
      : (host > joiner ? 'host' : 'joiner') === youAre ? 'You win' : 'They win';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6">
      <p className="m-0 text-4xl font-semibold tabular-nums">{host}&ndash;{joiner}</p>
      <p className="m-0 text-lg">{verdict}</p>
      <button type="button" onClick={onLeave} className="rounded-lg border border-line px-4 py-2 text-muted">
        Done
      </button>
    </div>
  );
}

/** Two players, one device. The same rules as online — the host simply awards both sides. */
function SplitMatch({ providerId, onLeave }: { providerId: string; onLeave: () => void }) {
  const [state, dispatch] = useMatch(
    // One device is trivially in agreement with itself, so nothing is compared here — but
    // it carries its own id all the same, so that split screen and online build the same
    // state from the same fields.
    useMemo(
      () => hostState({
        seed: (Math.random() * 0xffffffff) >>> 0, level: LEVEL, rounds: ROUNDS, providerId,
      }),
      [providerId],
    ),
    null,
  );
  const round = useRound(state);

  useEffect(() => {
    if (state.winner === null || state.finished) return;
    const id = window.setTimeout(() => dispatch({ type: 'advance' }), REVEAL_MS);
    return () => window.clearTimeout(id);
  }, [state.winner, state.finished, dispatch]);

  if (state.finished) return <Over state={state} youAre="both" onLeave={onLeave} />;
  if (!round) return null;

  // A decided round is a round being looked at. Nothing was picked wrongly — a match
  // reports only the tap that took it — so the reveal is the shared symbol and no crosses.
  const reveal = state.winner === null ? null : { shared: round.shared, wrong: [] };

  const half = (side: Side) => (
    <div
      className={`flex flex-1 items-center justify-center gap-2 px-2 ${side === 'joiner' ? 'rotate-180' : ''}`}
    >
      {round.cards.map((card, i) => (
        <CardView
          key={i}
          card={card}
          // Both halves see the same reveal at the same moment: one device, one round,
          // and the player who missed it is the one it is for.
          review={reveal}
          onTap={(symbolId) => {
            if (symbolId === round.shared) dispatch({ type: 'found', by: side });
          }}
          className="aspect-square w-full max-w-[9.5rem] shrink"
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-1 flex-col">
      {half('joiner')}
      <div className="border-y border-line py-2">
        <Scoreboard state={state} youAre="both" />
      </div>
      {half('host')}
    </div>
  );
}

/** The screen both online roles share once the channel is up. */
function OnlineMatch({
  state,
  dispatch,
  youAre,
  onLeave,
}: {
  state: PeerState;
  dispatch: (event: PeerEvent) => void;
  youAre: Side;
  onLeave: () => void;
}) {
  const round = useRound(state);

  useEffect(() => {
    if (youAre !== 'host' || state.winner === null || state.finished) return;
    const id = window.setTimeout(() => dispatch({ type: 'advance' }), REVEAL_MS);
    return () => window.clearTimeout(id);
  }, [youAre, state.winner, state.finished, dispatch]);

  if (state.finished) return <Over state={state} youAre={youAre} onLeave={onLeave} />;
  if (!round) return <Waiting note="Waiting for the game to start…" />;

  return (
    <div className="flex flex-1 flex-col gap-3">
      <Scoreboard state={state} youAre={youAre} />
      {/* Said once, on the first round, because nothing after it changes: the two devices
          hold different maps, so the match is on the one source both certainly have.
          Dohledavka uses no map at all, so this is information and never an apology. */}
      {state.mapsDiffer && state.round === 0 && (
        <p className="m-0 text-center text-xs text-muted">
          Your maps and theirs are not the same set, so this match uses generated ones.
        </p>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        {round.cards.map((card, i) => (
          <CardView
            key={i}
            card={card}
            // The host sets `winner` when it awards the round and the joiner when the
            // `result` arrives, so both screens mark the symbol off their own state and
            // neither of them waits for the other to say what to draw.
            review={
              state.winner === null ? null : { shared: round.shared, wrong: [] }
            }
            onTap={(symbolId) => {
              if (symbolId === round.shared) dispatch({ type: 'found' });
            }}
            className="aspect-square w-full max-w-[min(40vh,18rem)] shrink"
          />
        ))}
      </div>
    </div>
  );
}

function Waiting({ note }: { note: string }) {
  return <p className="flex flex-1 items-center justify-center text-center text-sm text-muted">{note}</p>;
}

function ShareBox({ label, code }: { label: string; code: string }) {
  const url = `${window.location.origin}${window.location.pathname}#/match/join/${code}`;
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const copy = (what: 'link' | 'code', text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-sm text-muted">{label}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => copy('link', url)}
          className="flex-1 rounded-lg border border-flag bg-flag px-3 py-2 font-semibold text-ink"
        >
          {copied === 'link' ? 'Copied' : 'Copy link'}
        </button>
        <button
          type="button"
          onClick={() => copy('code', code)}
          className="rounded-lg border border-line px-3 py-2 text-sm text-muted"
        >
          {copied === 'code' ? 'Copied' : 'Code'}
        </button>
      </div>
      {/* Shown as well as copyable: some chat apps strip or rewrite links, and then the
          raw code is the way through. */}
      <code
        data-invite
        className="block max-h-16 overflow-auto rounded-lg border border-line bg-ink-soft p-2 font-mono text-[10px] leading-tight break-all text-muted"
      >
        {code}
      </code>
    </div>
  );
}

function Failed({ onLeave, onSplit }: { onLeave: () => void; onSplit: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <p className="m-0 text-sm text-muted">
        No connection. Some networks &mdash; mobile data especially &mdash; block a direct
        link between two devices, and this app has no relay to fall back on.
      </p>
      <button type="button" onClick={onSplit} className="rounded-lg border border-flag bg-flag px-4 py-2 font-semibold text-ink">
        Play on this device
      </button>
      <button type="button" onClick={onLeave} className="text-sm text-muted">Back</button>
    </div>
  );
}

function useLinkState(transport: Transport | null) {
  const [linkState, setLinkState] = useState(transport?.state ?? 'connecting');
  useEffect(() => {
    if (!transport) return;
    setLinkState(transport.state);
    return transport.onStateChange(setLinkState);
  }, [transport]);
  return linkState;
}

function HostFlow({ providerId, onLeave }: { providerId: string; onLeave: () => void }) {
  const [side, setSide] = useState<HostSide | null>(null);
  const [answer, setAnswer] = useState('');
  const [rejected, setRejected] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [split, setSplit] = useState(false);

  const game = useMemo(
    () => ({ seed: (Math.random() * 0xffffffff) >>> 0, level: LEVEL, rounds: ROUNDS, providerId }),
    [providerId],
  );
  const [state, dispatch] = useMatch(useMemo(() => hostState(game), [game]), side?.transport ?? null);
  const linkState = useLinkState(side?.transport ?? null);

  useEffect(() => {
    let live = true;
    void createHost(game).then((made) => {
      if (live) setSide(made);
      else made.close();
    });
    return () => {
      live = false;
    };
  }, [game]);

  // The joiner has no game until it is told; hello goes out the moment the channel opens.
  useEffect(() => {
    if (linkState === 'open') side?.transport.send(encode(helloFor(state)));
    // Sent once per connection, not per state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkState, side]);

  useEffect(() => {
    if (linkState !== 'connecting' || !answer) return;
    const id = window.setTimeout(() => setTimedOut(true), CONNECT_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [linkState, answer]);

  if (split) return <SplitMatch providerId={providerId} onLeave={onLeave} />;
  if (linkState === 'failed' || timedOut) {
    return <Failed onLeave={onLeave} onSplit={() => setSplit(true)} />;
  }
  if (linkState === 'open') {
    return <OnlineMatch state={state} dispatch={dispatch} youAre="host" onLeave={onLeave} />;
  }

  return (
    <div className="flex flex-col gap-5 pt-2">
      <h2 className="m-0 text-base font-semibold">Host a game</h2>
      {!side ? (
        <Waiting note="Preparing…" />
      ) : (
        <>
          <ShareBox label="1. Send this to the other player." code={side.code} />
          <label className="flex flex-col gap-2">
            <span className="text-sm text-muted">2. Paste the code they send back.</span>
            <textarea
              value={answer}
              onChange={(e) => {
                setAnswer(e.target.value);
                setRejected(false);
              }}
              rows={3}
              className="w-full rounded-lg border border-line bg-ink-soft p-2 font-mono text-xs"
            />
          </label>
          <button
            type="button"
            disabled={answer.trim().length === 0}
            onClick={() => {
              void side.acceptAnswer(answer).then((ok) => setRejected(!ok));
            }}
            className="rounded-lg border border-line px-4 py-2 disabled:opacity-40"
          >
            Connect
          </button>
          {rejected && <p className="m-0 text-sm text-bad">That code did not work.</p>}
        </>
      )}
      <button type="button" onClick={onLeave} className="text-sm text-muted">Back</button>
    </div>
  );
}

function JoinFlow({
  providerId, offerCode, onLeave,
}: {
  providerId: string;
  offerCode: string | undefined;
  onLeave: () => void;
}) {
  const [typed, setTyped] = useState(offerCode ?? '');
  const [side, setSide] = useState<JoinerSide | null>(null);
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState(false);

  const [state, dispatch] = useMatch(
    useMemo(() => joinerState(providerId), [providerId]),
    side?.transport ?? null,
  );
  const linkState = useLinkState(side?.transport ?? null);

  const join = useCallback((code: string) => {
    setBusy(true);
    void joinWithCode(code).then((made) => {
      setBusy(false);
      if (made) setSide(made);
      else setRejected(true);
    });
  }, []);

  // A link opened from a message joins straight away rather than making the player press
  // a button whose only job is to repeat what the link already said.
  useEffect(() => {
    if (offerCode) join(offerCode);
  }, [offerCode, join]);

  if (split) return <SplitMatch providerId={providerId} onLeave={onLeave} />;
  if (linkState === 'failed') return <Failed onLeave={onLeave} onSplit={() => setSplit(true)} />;
  if (linkState === 'open') {
    return <OnlineMatch state={state} dispatch={dispatch} youAre="joiner" onLeave={onLeave} />;
  }

  return (
    <div className="flex flex-col gap-5 pt-2">
      <h2 className="m-0 text-base font-semibold">Join a game</h2>
      {side ? (
        <>
          <ShareBox label="Send this back to the host, then wait." code={side.code} />
          <Waiting note="Waiting for the host…" />
        </>
      ) : (
        <>
          <label className="flex flex-col gap-2">
            <span className="text-sm text-muted">Paste the code you were sent.</span>
            <textarea
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setRejected(false);
              }}
              rows={3}
              className="w-full rounded-lg border border-line bg-ink-soft p-2 font-mono text-xs"
            />
          </label>
          <button
            type="button"
            disabled={busy || typed.trim().length === 0}
            onClick={() => join(typed)}
            className="rounded-lg border border-flag bg-flag px-4 py-2 font-semibold text-ink disabled:opacity-40"
          >
            {busy ? 'Connecting…' : 'Join'}
          </button>
          {rejected && <p className="m-0 text-sm text-bad">That code did not work.</p>}
        </>
      )}
      <button type="button" onClick={onLeave} className="text-sm text-muted">Back</button>
    </div>
  );
}
