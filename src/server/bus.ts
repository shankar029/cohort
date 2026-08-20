import type { ServerMessage } from '@shared/index';

type Listener = (message: ServerMessage) => void;

/** Minimal pub/sub used to fan server-side events out to WebSocket clients. */
export class Bus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(message: ServerMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        /* a broken listener must not stop others */
      }
    }
  }
}
