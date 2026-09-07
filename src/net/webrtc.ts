import { decodeInvite, encodeInvite } from './invite.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import type { LinkState, Transport } from './transport.ts';

/**
 * The only file that constructs an RTCPeerConnection, and the only one no test covers —
 * everything with a decision in it lives in `peer.ts`, `invite.ts` and `protocol.ts`.
 *
 * Public STUN only. STUN gets through the ordinary home router by telling each peer its
 * own public address; it cannot help behind symmetric NAT or carrier-grade NAT, where the
 * router hands out a different port per destination and only a TURN relay would work.
 * A relay is a server, and this app has none — so the honest answer is to **fail with a
 * timeout and offer split screen**, never to hang on a connection that is not coming.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

/** Gathering usually finishes in well under a second; this is the giving-up point. */
const GATHER_TIMEOUT_MS = 4000;
/** How long to wait for the channel after both sides have exchanged codes. */
export const CONNECT_TIMEOUT_MS = 20_000;

export interface GameSetup {
  readonly seed: number;
  readonly level: number;
  readonly rounds: number;
}

export interface Side {
  /** The code to hand to the other player. */
  readonly code: string;
  readonly transport: Transport;
  close(): void;
}

export interface HostSide extends Side {
  /** Feed back the joiner's code. Resolves false if it was not a usable answer. */
  acceptAnswer(code: string): Promise<boolean>;
}

export interface JoinerSide extends Side {
  readonly game: GameSetup;
}

/**
 * Waits for ICE gathering to finish so a single code carries every candidate.
 *
 * Trickle ICE is the normal design and is wrong here: there is no signalling channel to
 * trickle over, and a code copied before gathering finished describes a peer that cannot
 * be reached. On timeout it returns anyway — a few candidates usually connect, and
 * candidates that never arrived would not have helped.
 */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/**
 * Builds the transport before the data channel necessarily exists.
 *
 * The joiner cannot wait for its channel: the channel only opens once the host has the
 * answer, and the host only gets the answer after `joinWithCode` returns it. Waiting
 * first is a deadlock that looks exactly like a peer who never replied, so the channel is
 * attached whenever it turns up and the transport reports `connecting` until then.
 */
function makeTransport(pc: RTCPeerConnection): {
  transport: Transport;
  attach: (channel: RTCDataChannel) => void;
} {
  const messageHandlers = new Set<(data: string) => void>();
  const stateHandlers = new Set<(state: LinkState) => void>();
  let state: LinkState = 'connecting';
  let channel: RTCDataChannel | null = null;

  const setState = (next: LinkState) => {
    if (state === next) return;
    state = next;
    for (const handler of [...stateHandlers]) handler(next);
  };

  const attach = (next: RTCDataChannel) => {
    channel = next;
    if (next.readyState === 'open') setState('open');
    next.addEventListener('open', () => setState('open'));
    next.addEventListener('close', () => setState('closed'));
    next.addEventListener('error', () => setState('failed'));
    next.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      for (const handler of [...messageHandlers]) handler(event.data);
    });
  };

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') setState('failed');
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') setState('closed');
  });

  const transport: Transport = {
    get state() {
      return state;
    },
    send(data) {
      // Dropped rather than queued while the channel is not up. Every message this
      // protocol sends is about the round in play, so a stale one delivered late would be
      // worse than one never sent.
      if (channel?.readyState === 'open') channel.send(data);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStateChange(handler) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
    close() {
      channel?.close();
      pc.close();
      setState('closed');
    },
  };

  return { transport, attach };
}

export async function createHost(game: GameSetup): Promise<HostSide> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  // `negotiated: false` keeps the usual in-band opening; the joiner picks it up through
  // ondatachannel. `ordered` is the default and is what the protocol assumes.
  const channel = pc.createDataChannel('ob', { ordered: true });
  const { transport, attach } = makeTransport(pc);
  attach(channel);

  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);

  const code = await encodeInvite({
    v: PROTOCOL_VERSION,
    sdp: pc.localDescription?.sdp ?? '',
    seed: game.seed,
    level: game.level,
    rounds: game.rounds,
  });

  return {
    code,
    transport,
    close: () => pc.close(),
    async acceptAnswer(answerCode: string): Promise<boolean> {
      const invite = await decodeInvite(answerCode);
      if (!invite) return false;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: ensureTrailingNewline(invite.sdp) });
        return true;
      } catch {
        // A well-formed code that is not an answer to *this* offer — usually a stale one
        // from an earlier attempt.
        return false;
      }
    },
  };
}

export async function joinWithCode(offerCode: string): Promise<JoinerSide | null> {
  const invite = await decodeInvite(offerCode);
  if (!invite || invite.seed === undefined || invite.level === undefined || invite.rounds === undefined) {
    return null;
  }

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const { transport, attach } = makeTransport(pc);
  // Attached when it arrives, which is after the host has been given the code below.
  pc.addEventListener('datachannel', (event) => attach(event.channel));

  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: ensureTrailingNewline(invite.sdp) });
    await pc.setLocalDescription(await pc.createAnswer());
  } catch {
    pc.close();
    return null;
  }
  await gathered(pc);

  const code = await encodeInvite({ v: PROTOCOL_VERSION, sdp: pc.localDescription?.sdp ?? '' });

  return {
    code,
    transport,
    close: () => pc.close(),
    game: { seed: invite.seed, level: invite.level, rounds: invite.rounds },
  };
}

/** Some stacks reject an SDP whose last line has no newline; `trimSdp` removes it. */
function ensureTrailingNewline(sdp: string): string {
  return sdp.endsWith('\n') ? sdp : `${sdp}\n`;
}
