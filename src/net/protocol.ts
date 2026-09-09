/**
 * The wire format for a two-player Dohledavka game.
 *
 * Only taps and outcomes cross the connection. Both peers derive the identical deck from
 * the seed carried in `hello`, which is why the golden determinism tests are load-bearing
 * rather than tidy: output that drifted between builds would desynchronise a game with
 * nothing on screen to say so.
 */
export const PROTOCOL_VERSION = 1;

export type Side = 'host' | 'joiner';

export interface Scores {
  readonly host: number;
  readonly joiner: number;
}

export type Message =
  /** Host to joiner, once, on connect. Everything needed to generate the same game. */
  | {
      readonly t: 'hello';
      readonly protocol: number;
      readonly seed: number;
      readonly level: number;
      readonly rounds: number;
      /**
       * Which maps the host's rounds come from — `'generated'`, `'library:<hashes>'`,
       * `'mixed:…'`. An **id and never a map**: content hashes and weights, no geometry,
       * which is the same privacy stance as the seed standing in for the deck.
       *
       * A round is a function of `(seed, level, provider.id)`, so two peers that agreed on
       * the first two and not the third would derive different rounds from one seed.
       * Dohledavka is a symbol drill and uses no map at all today, so nothing here changes
       * a deck; it is what a terrain drill would need the day one becomes multiplayer, and
       * carrying it now is what makes that day a UI change rather than a protocol change.
       *
       * **Optional, and the version did not move.** A peer on an older build sends no id
       * and refuses any protocol but its own, so bumping the version would have ended
       * every game with an older phone to add a field that older phone does not read.
       * Absent reads as `'generated'`, which is what an older build in fact plays.
       */
      readonly providerId?: string;
    }
  /**
   * Joiner to host: the maps I have.
   *
   * The other half of the comparison. Without it only the joiner could tell that the two
   * devices hold different libraries, and "both fall back to generated" would be one peer
   * falling back alone — which is the desync it exists to prevent. An older host drops it
   * as an unknown message and stays on what it always played, which is generated.
   */
  | { readonly t: 'maps'; readonly providerId?: string }
  /** Joiner to host: I have found it. Only correct taps are sent; a miss costs only time. */
  | { readonly t: 'tap'; readonly round: number }
  /** Host to joiner: who took the round, and the score as the host has it. */
  | { readonly t: 'result'; readonly round: number; readonly winner: Side; readonly scores: Scores }
  /** Host to joiner: move on. Progression is the host's call, like the outcome. */
  | { readonly t: 'next'; readonly round: number }
  | { readonly t: 'over'; readonly scores: Scores };

export function encode(message: Message): string {
  return JSON.stringify(message);
}

/**
 * Anything arriving over a data channel is untrusted — a peer on an old build, or simply
 * a corrupted frame. A bad message is dropped, never thrown on: the game carries on with
 * one lost tap rather than ending in a stack trace on somebody's phone.
 */
export function decode(raw: string): Message | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;

  const round = () => (typeof m.round === 'number' && Number.isInteger(m.round) ? m.round : null);
  const scores = () =>
    typeof m.scores === 'object' && m.scores !== null &&
    typeof (m.scores as Scores).host === 'number' &&
    typeof (m.scores as Scores).joiner === 'number'
      ? (m.scores as Scores)
      : null;

  // An id that is not a string is an id from a build this one does not understand, and is
  // dropped rather than carried: absent means "generated", which is a safe thing to be
  // wrong about, while `[object Object]` would be an id two peers could agree on by
  // accident.
  const providerId = () => (typeof m.providerId === 'string' ? { providerId: m.providerId } : {});

  switch (m.t) {
    case 'hello':
      return typeof m.protocol === 'number' &&
        typeof m.seed === 'number' &&
        typeof m.level === 'number' &&
        typeof m.rounds === 'number'
        ? {
            t: 'hello', protocol: m.protocol, seed: m.seed, level: m.level, rounds: m.rounds,
            ...providerId(),
          }
        : null;
    case 'maps':
      return { t: 'maps', ...providerId() };
    case 'tap': {
      const r = round();
      return r === null ? null : { t: 'tap', round: r };
    }
    case 'result': {
      const r = round();
      const s = scores();
      return r !== null && s !== null && (m.winner === 'host' || m.winner === 'joiner')
        ? { t: 'result', round: r, winner: m.winner, scores: s }
        : null;
    }
    case 'next': {
      const r = round();
      return r === null ? null : { t: 'next', round: r };
    }
    case 'over': {
      const s = scores();
      return s === null ? null : { t: 'over', scores: s };
    }
    default:
      return null;
  }
}
