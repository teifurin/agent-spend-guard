import { describe, expect, it } from 'vitest';
import { EventBus, type GuardEvent } from '../../src/server/events.js';

describe('EventBus', () => {
  it('delivers to subscribers, stops after unsubscribe and keeps a bounded history', () => {
    const bus = new EventBus({ keep: 2 });
    const seen: GuardEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    bus.publish({ type: 'request.decided', requestId: 'req_1', status: 'HELD', at: 10 });
    bus.publish({ type: 'owner.approved', requestId: 'req_1', status: 'APPROVED', at: 20 });
    bus.publish({ type: 'payment.captured', requestId: 'req_1', status: 'PAID', at: 30 });
    expect(seen.map((e) => e.type)).toEqual(['request.decided', 'owner.approved', 'payment.captured']);
    expect(bus.since(15).map((e) => e.at)).toEqual([20, 30]); // the first one fell out of the history
    expect(bus.subscriberCount).toBe(1);
    off();
    bus.publish({ type: 'x', at: 40 });
    expect(seen.length).toBe(3);
    expect(bus.subscriberCount).toBe(0);
  });

  it('stamps the time when none is given and survives a throwing subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => seen.push(e.type));
    const event = bus.publish({ type: 'mandate.linked' });
    expect(event.at).toBeGreaterThan(0);
    expect(seen).toEqual(['mandate.linked']);
  });
});
