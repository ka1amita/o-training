import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import { CardView } from '@/drills/dohledavka/Cards.tsx';
import { dohledavka } from '@/drills/dohledavka/drill.ts';
import { deriveSeed, seeded } from '@/lib/rng.ts';
import { helloFor, hostState, joinerState, peerReduce, type PeerEvent, type PeerState } from '@/net/peer.ts';
import { decode, encode, type Side } from '@/net/protocol.ts';
import type { Transport } from '@/net/transport.ts';
import { createHost, joinWithCode, CONNECT_TIMEOUT_MS, type HostSide, type JoinerSide } from '@/net/webrtc.ts';

const ROUNDS = 10;
const LEVEL = 5;
/** How long the result stays up before the host moves on. */
const RESULT_MS = 1400;

type Mode = 'lobby' | 'split' | 'host' | 'join';

export default function MatchPage() {
  const { code } = useParams<{ code?: string }>();
  const [mode, setMode] = useState<Mode>(code ? 'join' : 'lobby');

  if (mode === 'split') return <SplitMatch onLeave={() => setMode('lobby')} />;
  if (mode === 'host') return <HostFlow onLeave={() => setMode('lobby')} />;
  if (mode === 'join') return <JoinFlow offerCode={code} onLeave={() => setMode('lobby')} />;

  return (
    <div className="flex flex-col gap-3 pt-2">
      <h2 className="m-0 text-base font-semibold">Dohledavka &middot; two players</h2>
      <p className="m-0 text-sm text-muted">
        Both players see the same two cards. They share exactly one symbol &mdash; first to
        tap it takes the round.
      </p>
      <Choice title="Same device" note="Phone flat on the table, one half each." onClick={() => setMode('split')} />
      <Choice title="Host online" note="Send a link to the other player." onClick={() => setMode('host')} />
      <Choice title="Join online" note="Open a link you were sent, or paste the code." onClick={() => setMode('join')} />
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
    () => (state.started ? dohledavka.generate(seeded(deriveSeed(state.seed, state.round)), state.level) : null),
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
function SplitMatch({ onLeave }: { onLeave: () => void }) {
  const [state, dispatch] = useMatch(
    useMemo(() => hostState({ seed: (Math.random() * 0xffffffff) >>> 0, level: LEVEL, rounds: ROUNDS }), []),
    null,
  );
  const round = useRound(state);

  useEffect(() => {
    if (state.winner === null || state.finished) return;
    const id = window.setTimeout(() => dispatch({ type: 'advance' }), RESULT_MS);
    return () => window.clearTimeout(id);
  }, [state.winner, state.finished, dispatch]);

  if (state.finished) return <Over state={state} youAre="both" onLeave={onLeave} />;
  if (!round) return null;

  const half = (side: Side) => (
    <div
      className={`flex flex-1 items-center justify-center gap-2 px-2 ${side === 'joiner' ? 'rotate-180' : ''}`}
    >
      {round.cards.map((card, i) => (
        <CardView
          key={i}
          card={card}
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
    const id = window.setTimeout(() => dispatch({ type: 'advance' }), RESULT_MS);
    return () => window.clearTimeout(id);
  }, [youAre, state.winner, state.finished, dispatch]);

  if (state.finished) return <Over state={state} youAre={youAre} onLeave={onLeave} />;
  if (!round) return <Waiting note="Waiting for the game to start…" />;

  return (
    <div className="flex flex-1 flex-col gap-3">
      <Scoreboard state={state} youAre={youAre} />
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        {round.cards.map((card, i) => (
          <CardView
            key={i}
            card={card}
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

function HostFlow({ onLeave }: { onLeave: () => void }) {
  const [side, setSide] = useState<HostSide | null>(null);
  const [answer, setAnswer] = useState('');
  const [rejected, setRejected] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [split, setSplit] = useState(false);

  const game = useMemo(
    () => ({ seed: (Math.random() * 0xffffffff) >>> 0, level: LEVEL, rounds: ROUNDS }),
    [],
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

  if (split) return <SplitMatch onLeave={onLeave} />;
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

function JoinFlow({ offerCode, onLeave }: { offerCode: string | undefined; onLeave: () => void }) {
  const [typed, setTyped] = useState(offerCode ?? '');
  const [side, setSide] = useState<JoinerSide | null>(null);
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState(false);

  const [state, dispatch] = useMatch(useMemo(() => joinerState(), []), side?.transport ?? null);
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

  if (split) return <SplitMatch onLeave={onLeave} />;
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
