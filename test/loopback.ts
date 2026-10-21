import { Net, type DataChannelLike, type PeerLike } from '../src/net/net';

type AnyCb = (...args: any[]) => void;

/** In-memory data channel used to exercise the netcode without WebRTC. */
class LoopbackChannel implements DataChannelLike {
  peer: string;
  open = false;
  other: LoopbackChannel | null = null;
  private handlers: Record<string, AnyCb[]> = {};

  constructor(peer: string) {
    this.peer = peer;
  }

  on(event: string, cb: AnyCb): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers[event] ?? []) cb(...args);
  }

  send(data: unknown): void {
    if (!this.open || !this.other?.open) return;
    const target = this.other;
    setTimeout(() => target.emit('data', data), 0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
    if (this.other?.open) {
      this.other.open = false;
      this.other.emit('close');
    }
  }
}

class LoopbackPeer implements PeerLike {
  id: string;
  private handlers: Record<string, AnyCb[]> = {};

  constructor(id: string | undefined, private registry: Map<string, LoopbackPeer>) {
    this.id = id ?? `loop-${Math.random().toString(36).slice(2, 10)}`;
    this.registry.set(this.id, this);
    setTimeout(() => this.emit('open', this.id), 0);
  }

  on(event: string, cb: AnyCb): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers[event] ?? []) cb(...args);
  }

  connect(targetId: string): DataChannelLike {
    const target = this.registry.get(targetId);
    const mine = new LoopbackChannel(target ? target.id : 'unknown');
    if (!target) {
      setTimeout(() => this.emit('error', { type: 'peer-unavailable', message: 'no such peer' }), 0);
      return mine;
    }
    const theirs = new LoopbackChannel(this.id);
    mine.other = theirs;
    theirs.other = mine;
    setTimeout(() => {
      mine.open = true;
      theirs.open = true;
      mine.emit('open');
      theirs.emit('open');
      target.emit('connection', theirs);
    }, 0);
    return mine;
  }

  destroy(): void {
    this.registry.delete(this.id);
  }
}

/** Routes the Net module through the in-memory transport. */
export function installLoopbackTransport(): void {
  const registry = new Map<string, LoopbackPeer>();
  Net.peerFactory = (id) => new LoopbackPeer(id, registry);
}
