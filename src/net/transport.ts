/**
 * The seam between the game rules and WebRTC.
 *
 * `peer.ts` never sees an RTCPeerConnection, and nothing under test constructs one. The
 * fake below is also what the split-screen fallback runs on: two players on one device
 * are a "connection" that cannot fail, which is why that mode costs almost nothing on top
 * of the real one.
 */
export type LinkState = 'connecting' | 'open' | 'closed' | 'failed';

export interface Transport {
  send(data: string): void;
  /** Returns an unsubscribe function. */
  onMessage(handler: (data: string) => void): () => void;
  onStateChange(handler: (state: LinkState) => void): () => void;
  readonly state: LinkState;
  close(): void;
}

class Endpoint implements Transport {
  state: LinkState = 'open';
  peer: Endpoint | null = null;
  private messageHandlers = new Set<(data: string) => void>();
  private stateHandlers = new Set<(state: LinkState) => void>();
  /** Set by tests to drop, duplicate or delay what this endpoint delivers. */
  deliver: (data: string, arrive: (data: string) => void) => void = (d, a) => a(d);

  send(data: string): void {
    if (this.state !== 'open' || !this.peer) return;
    const peer = this.peer;
    this.deliver(data, (d) => peer.receive(d));
  }

  receive(data: string): void {
    for (const handler of [...this.messageHandlers]) handler(data);
  }

  onMessage(handler: (data: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: (state: LinkState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  setState(state: LinkState): void {
    this.state = state;
    for (const handler of [...this.stateHandlers]) handler(state);
  }

  close(): void {
    if (this.state === 'closed') return;
    this.setState('closed');
    this.peer?.setState('closed');
  }
}

export interface FakeLink {
  readonly a: Endpoint;
  readonly b: Endpoint;
}

/** Two endpoints wired to each other, delivering synchronously. */
export function fakeLink(): FakeLink {
  const a = new Endpoint();
  const b = new Endpoint();
  a.peer = b;
  b.peer = a;
  return { a, b };
}
