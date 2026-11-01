import { describe, expect, it, vi } from 'vitest';
import { requestPurchaseWithRetry } from '../../src/agent/purchase.js';

describe('demo purchase retry', () => {
  it('reuses identical intent and payload after the guard loses its answer', async () => {
    const purchaseCall = { name: 'request_purchase', arguments: { intent_id: 'purchase-123', merchant: 'Books', item: 'Notebook', amount: '12.00', currency: 'USD', category: 'books', reason: 'notes' } };
    const client = {
      callTool: vi.fn()
        .mockResolvedValueOnce({ isError: true, structuredContent: { error: 'guard_unreachable' } })
        .mockResolvedValueOnce({ isError: false, structuredContent: { request_id: 'req-123', status: 'PAID', replayed: true } }),
    };
    const retryNotice = vi.fn();
    const result = await requestPurchaseWithRetry(() => client.callTool(purchaseCall), retryNotice);
    expect(result.structuredContent).toMatchObject({ request_id: 'req-123', replayed: true });
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.callTool.mock.calls[0]?.[0]).toBe(purchaseCall);
    expect(client.callTool.mock.calls[1]?.[0]).toBe(purchaseCall);
    expect(client.callTool.mock.calls[1]?.[0]).toEqual(client.callTool.mock.calls[0]?.[0]);
    expect(retryNotice).toHaveBeenCalledOnce();
  });

  it.each(['PAID', 'HELD', 'BLOCKED', 'DENIED'])('does not resubmit a known %s outcome', async (status) => {
    const call = vi.fn().mockResolvedValue({ isError: false, structuredContent: { status } });
    await requestPurchaseWithRetry(call);
    expect(call).toHaveBeenCalledOnce();
  });

  it('never retries a conflict, and bounds unreachable retries to one', async () => {
    const conflict = vi.fn().mockResolvedValue({ isError: true, structuredContent: { error: 'intent_conflict' } });
    await requestPurchaseWithRetry(conflict);
    expect(conflict).toHaveBeenCalledOnce();
    const unavailable = vi.fn().mockResolvedValue({ isError: true, structuredContent: { error: 'guard_unreachable' } });
    expect((await requestPurchaseWithRetry(unavailable)).isError).toBe(true);
    expect(unavailable).toHaveBeenCalledTimes(2);
  });
});
