import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hostState, joinerState, peerReduce, helloFor, type PeerEvent, type PeerState } from './peer.ts';
import { PROTOCOL_VERSION, type Message, type Side } from './protocol.ts';

/**
 * Runs a host and a joiner against each other in process. Delivery is controllable, so
 * duplication and reordering — both of which a data channel permits — are ordinary cases
 * here rather than things noticed in a real game months later.
 */
class Game {
  host: PeerState;
  joiner: PeerState;
  private queue: { to: Side; message: Message }[] = [];

  constructor(rounds = 3, seed = 4242, level = 5, maps = ['generated', 'generated']) {
    this.host = hostState({ seed, level, rounds, providerId: maps[0]! });
    this.joiner = joinerState(maps[1]!);
    this.queue.push({ to: 'joiner', message: helloFor(this.host) });
  }

  private apply(side: Side, event: PeerEvent): void {
    const [next, outgoing] = peerReduce(this[side], event);
    this[side] = next;
    for (const message of outgoing) {
      this.queue.push({ to: side === 'host' ? 'joiner' : 'host', message });
    }
  }

  found(side: Side): this {
    this.apply(side, { type: 'found' });
    return this;
  }

  /** Split screen: both players tap on the host's device. */
  foundLocally(by: Side): this {
    this.apply('host', { type: 'found', by });
    return this;
  }

  advance(): this {
    this.apply('host', { type: 'advance' });
    return this;
  }

  /** Delivers everything queued, including anything produced along the way. */
  flush({ duplicate = false, reverse = false } = {}): this {
    let guard = 0;
    while (this.queue.length > 0) {
      if (guard++ > 500) throw new Error('delivery did not settle — messages are looping');
      let batch = this.queue;
      this.queue = [];
      if (reverse) batch = [...batch].reverse();
      if (duplicate) batch = batch.flatMap((m) => [m, m]);
      for (const { to, message } of batch) this.apply(to, { type: 'received', message });
    }
    return this;
  }

  get agreed(): boolean {
    return (
      this.host.scores.host === this.joiner.scores.host &&
      this.host.scores.joiner === this.joiner.scores.joiner &&
      this.host.round === this.joiner.round
    );
  }
}

describe('peer / handshake', () => {
  it('hello carries everything the joiner needs to build the same game', () => {
    const g = new Game(5, 99, 7).flush();
    expect(g.joiner.started).toBe(true);
    expect(g.joiner.seed).toBe(g.host.seed);
    expect(g.joiner.level).toBe(g.host.level);
    expect(g.joiner.rounds).toBe(g.host.rounds);
  });

  it('refuses a peer on another protocol rather than playing a different deck', () => {
    const joiner = joinerState();
    const [after] = peerReduce(joiner, {
      type: 'received',
      message: { t: 'hello', protocol: PROTOCOL_VERSION + 1, seed: 1, level: 1, rounds: 3 },
    });
    expect(after.started).toBe(false);
  });

  it('a joiner that has not had hello yet sends nothing when it taps', () => {
    const [, outgoing] = peerReduce(joinerState(), { type: 'found' });
    expect(outgoing).toEqual([]);
  });
});

describe('peer / which maps the match runs on', () => {
  const LIBRARY = 'library:abc123';

  it('two devices holding the same maps play on them', () => {
    const g = new Game(3, 1, 5, [LIBRARY, LIBRARY]).flush();
    expect(g.host.providerId).toBe(LIBRARY);
    expect(g.joiner.providerId).toBe(LIBRARY);
    expect(g.host.mapsDiffer).toBe(false);
    expect(g.joiner.mapsDiffer).toBe(false);
  });

  it('two devices holding different maps both fall back to generated', () => {
    // The desync this exists to prevent: a round is a function of (seed, level,
    // provider.id), so one peer resolving an id the other cannot would be two games with
    // one scoreboard. Both sides reach the same answer from the same two ids.
    const g = new Game(3, 1, 5, [LIBRARY, 'library:other']).flush();
    expect(g.host.providerId).toBe('generated');
    expect(g.joiner.providerId).toBe('generated');
    expect(g.host.mapsDiffer).toBe(true);
    expect(g.joiner.mapsDiffer).toBe(true);
  });

  it('says nothing when both are simply on the default', () => {
    const g = new Game().flush();
    expect(g.host.mapsDiffer).toBe(false);
    expect(g.joiner.mapsDiffer).toBe(false);
    expect(g.host.providerId).toBe('generated');
  });

  it('a peer on an older build still plays, on generated', () => {
    // No `providerId` in its hello, and no answer to ours. The host therefore never
    // upgrades past generated, which is exactly what that older build plays.
    const joiner = joinerState(LIBRARY);
    const [afterHello, out] = peerReduce(joiner, {
      type: 'received',
      message: { t: 'hello', protocol: PROTOCOL_VERSION, seed: 7, level: 3, rounds: 4 },
    });
    expect(afterHello.started).toBe(true);
    expect(afterHello.providerId).toBe('generated');
    expect(afterHello.mapsDiffer).toBe(true);
    expect(out).toEqual([{ t: 'maps', providerId: LIBRARY }]);

    const host = hostState({ seed: 7, level: 3, rounds: 4, providerId: LIBRARY });
    expect(host.providerId).toBe('generated');
  });

  it('a repeated answer changes nothing', () => {
    const g = new Game(3, 1, 5, [LIBRARY, LIBRARY]).flush({ duplicate: true });
    expect(g.host.providerId).toBe(LIBRARY);
    expect(g.host.mapsDiffer).toBe(false);
  });

  it('only the host reads an answer, and only a joiner reads hello', () => {
    const g = new Game(3, 1, 5, [LIBRARY, LIBRARY]).flush();
    const [joiner] = peerReduce(g.joiner, {
      type: 'received',
      message: { t: 'maps', providerId: 'library:someone-else' },
    });
    expect(joiner.providerId).toBe(LIBRARY);
    const [host] = peerReduce(g.host, {
      type: 'received',
      message: { t: 'hello', protocol: PROTOCOL_VERSION, seed: 1, level: 1, rounds: 1 },
    });
    expect(host.seed).toBe(g.host.seed);
  });

  it('carries an id and never a map', () => {
    // The privacy stance, as a test: what crosses the wire is a hash and a weight, and a
    // library id is a list of content hashes. No geometry, ever.
    const hello = helloFor(hostState({ seed: 1, level: 1, rounds: 1, providerId: LIBRARY }));
    expect(JSON.stringify(hello)).toBe(
      `{"t":"hello","protocol":${PROTOCOL_VERSION},"seed":1,"level":1,"rounds":1,"providerId":"${LIBRARY}"}`,
    );
  });
});

describe('peer / one round', () => {
  it('the host taking it is seen by both', () => {
    const g = new Game().flush().found('host').flush();
    expect(g.host.winner).toBe('host');
    expect(g.joiner.winner).toBe('host');
    expect(g.agreed).toBe(true);
    expect(g.host.scores).toEqual({ host: 1, joiner: 0 });
  });

  it('the joiner taking it is seen by both', () => {
    const g = new Game().flush().found('joiner').flush();
    expect(g.host.winner).toBe('joiner');
    expect(g.joiner.winner).toBe('joiner');
    expect(g.host.scores).toEqual({ host: 0, joiner: 1 });
    expect(g.agreed).toBe(true);
  });

  it('when both find it, the host resolves it and both agree', () => {
    // The case the authority exists for: each player saw their own tap first.
    const g = new Game().flush();
    g.found('joiner'); // queued, not yet delivered
    g.found('host');   // resolved locally, straight away
    g.flush();
    expect(g.host.winner).toBe('host');
    expect(g.joiner.winner).toBe('host');
    expect(g.host.scores).toEqual({ host: 1, joiner: 0 });
    expect(g.agreed).toBe(true);
  });

  it('a second tap in the same round changes nothing', () => {
    const g = new Game().flush().found('host').found('host').found('joiner').flush();
    expect(g.host.scores).toEqual({ host: 1, joiner: 0 });
  });

  it('does not advance while the round is undecided', () => {
    const g = new Game().flush().advance().flush();
    expect(g.host.round).toBe(0);
    expect(g.agreed).toBe(true);
  });
});

describe('peer / delivery is not reliable', () => {
  it('duplicated messages do not double-count', () => {
    const g = new Game().flush({ duplicate: true }).found('joiner').flush({ duplicate: true });
    expect(g.host.scores).toEqual({ host: 0, joiner: 1 });
    expect(g.joiner.scores).toEqual({ host: 0, joiner: 1 });
    expect(g.agreed).toBe(true);
  });

  it('reordered batches still converge', () => {
    const g = new Game(3).flush({ reverse: true });
    g.found('host').flush({ reverse: true }).advance().flush({ reverse: true });
    g.found('joiner').flush({ reverse: true });
    expect(g.agreed).toBe(true);
    expect(g.host.scores).toEqual({ host: 1, joiner: 1 });
  });

  it('a stale tap from a round already decided is ignored', () => {
    const g = new Game(3).flush().found('host').flush().advance().flush();
    const [after, out] = peerReduce(g.host, { type: 'received', message: { t: 'tap', round: 0 } });
    expect(after.scores).toEqual(g.host.scores);
    expect(out).toEqual([]);
  });

  it('a repeated `next` does not skip a round', () => {
    const g = new Game(4).flush().found('host').flush().advance().flush();
    expect(g.joiner.round).toBe(1);
    const [after] = peerReduce(g.joiner, { type: 'received', message: { t: 'next', round: 1 } });
    expect(after.round).toBe(1);
  });
});

describe('peer / split screen', () => {
  it('awards a local tap to either player, using the same rules', () => {
    const a = new Game(3).flush().foundLocally('joiner');
    expect(a.host.winner).toBe('joiner');
    expect(a.host.scores).toEqual({ host: 0, joiner: 1 });

    const b = new Game(3).flush().foundLocally('host');
    expect(b.host.scores).toEqual({ host: 1, joiner: 0 });
  });

  it('still gives the round to whoever was first', () => {
    const g = new Game(3).flush().foundLocally('joiner').foundLocally('host');
    expect(g.host.winner).toBe('joiner');
    expect(g.host.scores).toEqual({ host: 0, joiner: 1 });
  });

  it('a joiner cannot award anyone, even asked to', () => {
    const g = new Game(3).flush();
    const [after, out] = peerReduce(g.joiner, { type: 'found', by: 'joiner' });
    expect(after.scores).toEqual({ host: 0, joiner: 0 });
    expect(out).toEqual([{ t: 'tap', round: 0 }]);
  });
});

describe('peer / a whole game', () => {
  it('ends with both sides holding the same score', () => {
    const g = new Game(4).flush();
    for (const side of ['host', 'joiner', 'joiner', 'host'] as const) {
      g.found(side).flush().advance().flush();
    }
    expect(g.host.finished).toBe(true);
    expect(g.joiner.finished).toBe(true);
    expect(g.host.scores).toEqual({ host: 2, joiner: 2 });
    expect(g.joiner.scores).toEqual(g.host.scores);
  });

  it('accepts nothing once it is over', () => {
    const g = new Game(1).flush().found('host').flush().advance().flush();
    expect(g.host.finished).toBe(true);
    const before = g.host;
    expect(peerReduce(before, { type: 'found' })[0]).toBe(before);
  });

  it('converges for any sequence of taps and advances, however delivery behaves', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            side: fc.constantFrom<Side>('host', 'joiner'),
            act: fc.boolean(),
            duplicate: fc.boolean(),
            reverse: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        (steps) => {
          const g = new Game(6).flush();
          for (const step of steps) {
            if (step.act) g.found(step.side);
            else g.advance();
            g.flush({ duplicate: step.duplicate, reverse: step.reverse });
          }
          // Whatever happened, the two sides never disagree about the score, and the
          // total is never more than the rounds actually played.
          expect(g.joiner.scores).toEqual(g.host.scores);
          const total = g.host.scores.host + g.host.scores.joiner;
          expect(total).toBeLessThanOrEqual(g.host.rounds);
        },
      ),
      { numRuns: 300 },
    );
  });
});
