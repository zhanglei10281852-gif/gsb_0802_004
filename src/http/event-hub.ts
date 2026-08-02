import type { CausalEvent } from '../domain/types.js';

export type SSEMessage =
  | { type: 'snapshot'; data: unknown }
  | { type: 'event'; event: CausalEvent };

export type SSEWriter = (message: SSEMessage) => void;
export type Unsubscribe = () => void;

export class EventHub {
  private subscribers = new Set<SSEWriter>();

  subscribe(writer: SSEWriter): Unsubscribe {
    this.subscribers.add(writer);
    return () => {
      this.subscribers.delete(writer);
    };
  }

  publish(event: CausalEvent): void {
    for (const writer of this.subscribers) {
      try {
        writer({ type: 'event', event });
      } catch {
        this.subscribers.delete(writer);
      }
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
