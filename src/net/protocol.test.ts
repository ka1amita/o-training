import { describe, it, expect } from 'vitest';
import { decode, encode, PROTOCOL_VERSION, type Message } from './protocol.ts';

const hello = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, seed: 1, level: 2, rounds: 3, ...extra });

describe('protocol / decode', () => {
  it('round-trips every message', () => {
    const messages: Message[] = [
      { t: 'hello', protocol: PROTOCOL_VERSION, seed: 1, level: 2, rounds: 3 },
      { t: 'hello', protocol: PROTOCOL_VERSION, seed: 1, level: 2, rounds: 3, providerId: 'library:a,b' },
      // An adjusted id is a longer string and nothing else — the wire does not know what
      // a source is, and the protocol version did not have to move to carry a new one.
      { t: 'hello', protocol: PROTOCOL_VERSION, seed: 1, level: 2, rounds: 3, providerId: 'adjusted:0.5:library:a,b' },
      { t: 'maps', providerId: 'adjusted:1:library:a' },
      { t: 'maps', providerId: 'generated' },
      { t: 'tap', round: 2 },
      { t: 'result', round: 2, winner: 'joiner', scores: { host: 1, joiner: 2 } },
      { t: 'next', round: 3 },
      { t: 'over', scores: { host: 3, joiner: 3 } },
    ];
    for (const message of messages) expect(decode(encode(message))).toEqual(message);
  });

  it('reads a hello from a build that had no maps to name', () => {
    // The compatibility this field was made optional for: an older peer sends no id, and
    // `peer.ts` reads absent as generated, which is what that build in fact plays.
    expect(decode(hello())).toEqual({
      t: 'hello', protocol: PROTOCOL_VERSION, seed: 1, level: 2, rounds: 3,
    });
  });

  it('drops an id that is not a string rather than carrying it', () => {
    // Absent means generated, which is a safe thing to be wrong about. `[object Object]`
    // would be an id two peers could agree on by accident.
    for (const junk of [42, null, { hash: 'a' }, ['a']]) {
      expect(decode(hello({ providerId: junk }))).not.toHaveProperty('providerId');
    }
    expect(decode(JSON.stringify({ t: 'maps', providerId: 7 }))).toEqual({ t: 'maps' });
  });

  it('drops anything that is not a message', () => {
    for (const junk of ['', '{', 'null', '4', '[]', '{"t":"imaginary"}', '{"t":"tap"}']) {
      expect(decode(junk), junk).toBeNull();
    }
  });

  it('drops a message whose fields are the wrong shape', () => {
    expect(decode(hello({ seed: 'x' }))).toBeNull();
    expect(decode(JSON.stringify({ t: 'tap', round: 1.5 }))).toBeNull();
    expect(decode(JSON.stringify({ t: 'result', round: 1, winner: 'nobody', scores: { host: 0, joiner: 0 } }))).toBeNull();
    expect(decode(JSON.stringify({ t: 'over', scores: { host: 0 } }))).toBeNull();
  });
});
