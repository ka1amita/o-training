import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { encodeInvite, decodeInvite, trimSdp } from './invite.ts';
import { PROTOCOL_VERSION } from './protocol.ts';

/** A realistic data-channel offer, candidates and all. */
const SDP = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS
m=application 51772 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 192.0.2.33
a=candidate:2999745851 1 udp 2122260223 192.0.2.33 51772 typ host generation 0 ufrag TJ8t network-id 1
a=candidate:1510613869 1 udp 1686052607 198.51.100.7 51772 typ srflx raddr 192.0.2.33 rport 51772 generation 0 ufrag TJ8t network-id 1
a=candidate:3777982275 1 tcp 1518280447 192.0.2.33 9 typ host tcptype active generation 0 ufrag TJ8t network-id 1
a=ice-ufrag:TJ8t
a=ice-pwd:jVLxYnPYFyLmJDMHfPzGtGmM
a=ice-options:trickle
a=fingerprint:sha-256 8E:F6:1B:52:9A:2D:44:C1:0F:9A:D2:59:1C:32:73:15:8E:F6:1B:52:9A:2D:44:C1:0F:9A:D2:59:1C:32:73:15
a=setup:actpass
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=rtcp-mux
a=ssrc:1234567890 cname:abcdefg`;

describe('invite codec', () => {
  it('round-trips an offer', async () => {
    const code = await encodeInvite({ v: PROTOCOL_VERSION, sdp: SDP, seed: 12345, level: 7, rounds: 12 });
    const back = await decodeInvite(code);
    expect(back?.seed).toBe(12345);
    expect(back?.level).toBe(7);
    expect(back?.rounds).toBe(12);
    expect(back?.sdp).toContain('a=ice-ufrag:TJ8t');
    expect(back?.sdp).toContain('a=sctp-port:5000');
    expect(back?.sdp).toContain('typ srflx');
  });

  it('round-trips an answer, which carries no game fields', async () => {
    const code = await encodeInvite({ v: PROTOCOL_VERSION, sdp: SDP });
    const back = await decodeInvite(code);
    expect(back?.seed).toBeUndefined();
    expect(back?.sdp).toContain('a=fingerprint');
  });

  it('is short enough to paste into a chat app', async () => {
    const code = await encodeInvite({ v: PROTOCOL_VERSION, sdp: SDP, seed: 1, level: 5, rounds: 12 });
    // The raw SDP is around 1.4 kB. Anything past a few hundred characters and nobody
    // sends it, so this is a product requirement rather than a nicety.
    expect(code.length).toBeLessThan(700);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe, no padding to be eaten
  });

  it('keeps everything a data channel needs and drops what it does not', () => {
    const trimmed = trimSdp(SDP);
    for (const required of [
      'a=ice-ufrag:', 'a=ice-pwd:', 'a=fingerprint:', 'a=setup:', 'a=mid:0',
      'a=sctp-port:5000', 'm=application', 'a=candidate:',
    ]) {
      expect(trimmed, required).toContain(required);
    }
    expect(trimmed).not.toContain('a=extmap:1');
    expect(trimmed).not.toContain('a=rtcp-mux');
    expect(trimmed).not.toContain('a=ssrc:');
    // extmap-allow-mixed is a session line, not the a=extmap: attribute — keep it.
    expect(trimmed).toContain('a=extmap-allow-mixed');
  });

  it('survives whitespace a chat app may add', async () => {
    const code = await encodeInvite({ v: PROTOCOL_VERSION, sdp: SDP, seed: 9 });
    const mangled = `  ${code.slice(0, 40)}\n${code.slice(40)}  `;
    expect((await decodeInvite(mangled))?.seed).toBe(9);
  });

  it('returns null for anything that is not a code, rather than throwing', async () => {
    for (const junk of ['', '   ', 'hello', '!!!!', 'AAAA', 'a'.repeat(500)]) {
      expect(await decodeInvite(junk), junk.slice(0, 12)).toBeNull();
    }
  });

  it('returns null for a truncated code', async () => {
    const code = await encodeInvite({ v: PROTOCOL_VERSION, sdp: SDP, seed: 1 });
    expect(await decodeInvite(code.slice(0, Math.floor(code.length / 2)))).toBeNull();
  });

  it('refuses a code from another protocol version', async () => {
    const code = await encodeInvite({ v: PROTOCOL_VERSION + 1, sdp: SDP });
    expect(await decodeInvite(code)).toBeNull();
  });

  it('round-trips arbitrary sdp-shaped text', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 400 }).filter((s) => trimSdp(s).length > 0),
        fc.integer({ min: 0, max: 0xffffffff }),
        async (sdp, seed) => {
          const back = await decodeInvite(await encodeInvite({ v: PROTOCOL_VERSION, sdp, seed }));
          expect(back?.sdp).toBe(trimSdp(sdp));
          expect(back?.seed).toBe(seed);
        },
      ),
      { numRuns: 60 },
    );
  });
});
