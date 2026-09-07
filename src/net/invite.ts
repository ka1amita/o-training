import { PROTOCOL_VERSION } from './protocol.ts';

/**
 * The thing a player pastes into a chat app.
 *
 * A data-channel SDP with its candidates runs to a couple of kilobytes, which nobody will
 * copy by hand — so it is trimmed of the lines a data channel does not use, gzipped, and
 * base64url'd. The result is short enough to send in a message, which is the whole
 * difference between this feature working and being abandoned.
 */
export interface Invite {
  readonly v: number;
  readonly sdp: string;
  /** Present on an offer only: everything the joiner needs to build the same game. */
  readonly seed?: number;
  readonly level?: number;
  readonly rounds?: number;
}

/**
 * Lines an `application/sctp` m-section never needs. Dropping them is safe because the
 * answerer re-derives everything real from the remaining fields; what is left is the
 * fingerprint, ICE credentials, candidates and the sctp map, all of which are required.
 */
// The `(:|$)` is load-bearing: without it `extmap` also matches the session-level
// `a=extmap-allow-mixed`, which is a BUNDLE attribute and not an extmap at all.
const DROPPABLE =
  /^a=(extmap|rtcp-mux|rtcp-rsize|ssrc|msid|rtpmap|fmtp|rtcp-fb|sendrecv|inactive)(:|$)/;

export function trimSdp(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !DROPPABLE.test(line))
    .join('\n');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: spreading a few thousand bytes into fromCharCode overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function pipe(
  data: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
) {
  const writer = stream.writable.getWriter();
  // The handler is attached synchronously and on purpose. When the stream errors — which
  // is every malformed paste — the write side rejects independently of the read side, and
  // without this it surfaces as an unhandled rejection: a caught, handled failure that
  // still prints a stack trace in the player's console.
  const written = writer
    .write(data)
    .then(() => writer.close())
    .catch(() => undefined);
  try {
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  } finally {
    await written;
  }
}

export async function encodeInvite(invite: Invite): Promise<string> {
  const json = JSON.stringify({ ...invite, sdp: trimSdp(invite.sdp) });
  const gzipped = await pipe(new TextEncoder().encode(json), new CompressionStream('gzip'));
  return toBase64Url(gzipped);
}

/**
 * Everything about a pasted code is untrusted: it arrives through a chat app, may be
 * truncated by it, and may come from an older build. Every failure is the same answer —
 * null, so the screen can say "that code did not work" instead of throwing.
 */
export async function decodeInvite(code: string): Promise<Invite | null> {
  try {
    const cleaned = code.trim().replace(/\s+/g, '');
    if (cleaned.length === 0) return null;
    const bytes = await pipe(fromBase64Url(cleaned), new DecompressionStream('gzip'));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const invite = parsed as Record<string, unknown>;
    if (invite.v !== PROTOCOL_VERSION) return null;
    if (typeof invite.sdp !== 'string' || invite.sdp.length === 0) return null;

    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const seed = num(invite.seed);
    const level = num(invite.level);
    const rounds = num(invite.rounds);
    return {
      v: PROTOCOL_VERSION,
      sdp: invite.sdp,
      ...(seed !== undefined ? { seed } : {}),
      ...(level !== undefined ? { level } : {}),
      ...(rounds !== undefined ? { rounds } : {}),
    };
  } catch {
    return null;
  }
}
