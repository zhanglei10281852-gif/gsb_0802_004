import type { CausalEvent } from '../core/types.js';

type Listener = (event: CausalEvent) => void;

export class EventHub {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: CausalEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* listener errors must not break publishing */
      }
    }
  }
}
