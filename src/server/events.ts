/**
 * In-process event bus: every state change in the guard is published here and the dashboard's SSE stream
 * forwards it to open browsers. Payloads carry ids and statuses only, never secrets.
 */
export interface GuardEvent {
  /** Dotted name such as 'request.decided', 'payment.captured', 'mandate.linked'. */
  type: string;
  requestId?: string;
  agentId?: string;
  status?: string;
  at: number;
}

export type Listener = (event: GuardEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();
  private readonly history: GuardEvent[] = [];
  private readonly keep: number;

  constructor(opts: { keep?: number } = {}) {
    this.keep = opts.keep ?? 50;
  }

  publish(event: Omit<GuardEvent, 'at'> & { at?: number }): GuardEvent {
    const full: GuardEvent = { ...event, at: event.at ?? Date.now() };
    this.history.push(full);
    if (this.history.length > this.keep) this.history.splice(0, this.history.length - this.keep);
    for (const listener of [...this.listeners]) {
      try {
        listener(full);
      } catch {
        // a broken subscriber must not stop the others
      }
    }
    return full;
  }

  /** Returns the function that unsubscribes. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Events published after the given timestamp, oldest first; lets a reconnecting browser catch up. */
  since(at: number): GuardEvent[] {
    return this.history.filter((e) => e.at > at);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
