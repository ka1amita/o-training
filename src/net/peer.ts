import { PROTOCOL_VERSION, type Message, type Scores, type Side } from './protocol.ts';

/**
 * The game rules for a two-player match, as `(state, event) -> [state, outgoing]`.
 *
 * Pure, so a test can run a host and a joiner against each other in process and assert
 * they converge — including when messages arrive twice or out of order, which a data
 * channel permits and a real game will eventually see. `RTCPeerConnection` appears
 * nowhere in here and nowhere in its tests.
 *
 * **The host decides.** Without one authority both peers see their own tap as first and
 * the two screens disagree about who won. The joiner pays a little latency for that; on a
 * two-player game that is the right trade, and the alternative is a clock nobody has.
 */
export interface PeerState {
  readonly side: Side;
  readonly round: number;
  readonly rounds: number;
  readonly seed: number;
  readonly level: number;
  readonly scores: Scores;
  /** Who took the current round, or null while it is still open. */
  readonly winner: Side | null;
  readonly started: boolean;
  readonly finished: boolean;
}

export type PeerEvent =
  | { readonly type: 'received'; readonly message: Message }
  /**
   * Someone on this device found the shared symbol. `by` is how split screen reuses these
   * rules unchanged: two players on one device are both "local", and the host awards to
   * whichever half tapped. A joiner ignores it — it has no authority to award anyone.
   */
  | { readonly type: 'found'; readonly by?: Side }
  /** The host's cue to move on, after the result has been shown. */
  | { readonly type: 'advance' };

export interface HostGame {
  readonly seed: number;
  readonly level: number;
  readonly rounds: number;
}

const NO_SCORE: Scores = { host: 0, joiner: 0 };

export function hostState(game: HostGame): PeerState {
  return {
    side: 'host', round: 0, rounds: game.rounds, seed: game.seed, level: game.level,
    scores: NO_SCORE, winner: null, started: true, finished: false,
  };
}

/** The joiner knows nothing until `hello` arrives, so it starts empty and unstarted. */
export function joinerState(): PeerState {
  return {
    side: 'joiner', round: 0, rounds: 0, seed: 0, level: 0,
    scores: NO_SCORE, winner: null, started: false, finished: false,
  };
}

type Step = readonly [PeerState, readonly Message[]];

export function peerReduce(state: PeerState, event: PeerEvent): Step {
  if (state.finished) return [state, []];

  switch (event.type) {
    case 'found':
      return state.side === 'host'
        ? award(state, event.by ?? 'host')
        // The joiner never awards itself; it asks. If the host has already given the
        // round away this message is ignored there, which is the point of asking.
        : [state, state.winner === null && state.started ? [{ t: 'tap', round: state.round }] : []];

    case 'advance':
      return state.side === 'host' ? nextRound(state) : [state, []];

    case 'received':
      return receive(state, event.message);
  }
}

function receive(state: PeerState, message: Message): Step {
  switch (message.t) {
    case 'hello': {
      // A peer on a different protocol would derive a different deck from the same seed,
      // so the game is refused rather than played wrong.
      if (state.side !== 'joiner' || message.protocol !== PROTOCOL_VERSION) return [state, []];
      if (state.started) return [state, []]; // a repeat of hello changes nothing
      return [
        { ...state, seed: message.seed, level: message.level, rounds: message.rounds, started: true },
        [],
      ];
    }

    case 'tap':
      // Only the host resolves, only for the round in play, and only once. That single
      // condition covers a duplicate delivery and a tap for a round already given away.
      if (state.side !== 'host' || message.round !== state.round || state.winner !== null) {
        return [state, []];
      }
      return award(state, 'joiner');

    case 'result': {
      if (state.side !== 'joiner') return [state, []];
      if (message.round !== state.round || state.winner !== null) return [state, []];
      // Scores come from the host rather than being counted here, so a dropped message
      // costs one round's display and never a running total that drifts apart.
      return [{ ...state, winner: message.winner, scores: message.scores }, []];
    }

    case 'next':
      if (state.side !== 'joiner') return [state, []];
      // Idempotent: `next` for the round already in play is a repeat.
      if (message.round !== state.round + 1) return [state, []];
      return [{ ...state, round: message.round, winner: null }, []];

    case 'over':
      if (state.side !== 'joiner') return [state, []];
      return [{ ...state, scores: message.scores, finished: true }, []];
  }
}

function award(state: PeerState, winner: Side): Step {
  if (state.winner !== null || !state.started) return [state, []];
  const scores: Scores = {
    host: state.scores.host + (winner === 'host' ? 1 : 0),
    joiner: state.scores.joiner + (winner === 'joiner' ? 1 : 0),
  };
  return [
    { ...state, winner, scores },
    [{ t: 'result', round: state.round, winner, scores }],
  ];
}

function nextRound(state: PeerState): Step {
  // Nothing moves until the round has actually been decided; an early advance would skip
  // a round on the host and leave the joiner behind.
  if (state.winner === null) return [state, []];

  const round = state.round + 1;
  if (round >= state.rounds) {
    return [{ ...state, finished: true }, [{ t: 'over', scores: state.scores }]];
  }
  return [{ ...state, round, winner: null }, [{ t: 'next', round }]];
}

/** The opening message a host sends as soon as the channel is up. */
export function helloFor(state: PeerState): Message {
  return {
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    seed: state.seed,
    level: state.level,
    rounds: state.rounds,
  };
}
