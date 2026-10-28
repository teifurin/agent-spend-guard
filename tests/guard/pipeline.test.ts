import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { Repo } from '../../src/db/repo.js';
import type { Payment } from '../../src/domain/types.js';
import type { PayPalExecutor } from '../../src/guard/executor.js';
import { finalFromVerdict, Guard, passthroughReviewer, type Reviewer, tighter } from '../../src/guard/pipeline.js';

const NOON_JST = Date.UTC(2026, 9, 28, 3, 0);

function setup(opts: { reviewer?: Reviewer; reviewTimeoutMs?: number; executor?: PayPalExecutor } = {}) {
  const repo = new Repo(openDatabase(), () => NOON_JST);
  repo.createAgent({ id: 'research-bot', name: 'Research bot' });
  repo.savePolicy({
    agentId: 'research-bot',
    currency: 'USD',
    maxTxMinor: 3000,
    hardMaxTxMinor: 20000,
    monthlyBudgetMinor: 10000,
    merchantAllowlist: ['Synthetic Books', 'Synthetic Supplies'],
    categoryAllowlist: null,
    hours: { start: '08:00', end: '22:00' },
    timezone: 'Asia/Tokyo',
    holdNewMerchants: true,
  });
  const guard = new Guard({ repo, now: () => NOON_JST, ...opts });
  return { repo, guard };
}

const ok = { agentId: 'research-bot', merchant: 'Synthetic Books', item: 'Field notebook', category: 'books', amountMinor: 1200, currency: 'USD', reason: 'notes for the survey' };

/** A stand-in for the PayPal executor: the pipeline only ever calls charge(). */
function fakeExecutor(status: Payment['status'] = 'COMPLETED') {
  const charge = vi.fn(async (requestId: string): Promise<Payment> => ({
    id: 'pay_fake',
    requestId,
    agentId: 'research-bot',
    paypalOrderId: 'O1',
    paypalCaptureId: 'C1',
    paypalRefundId: null,
    amountMinor: 1200,
    currency: 'USD',
    status,
    capturedAt: NOON_JST,
    createdAt: NOON_JST,
    updatedAt: NOON_JST,
  }));
  return { charge, executor: { charge } as unknown as PayPalExecutor };
}

describe('composition rules', () => {
  it('maps verdicts to decisions and only ever tightens', () => {
    expect(finalFromVerdict('ALLOW')).toBe('AUTO_APPROVE');
    expect(finalFromVerdict('HOLD')).toBe('HOLD');
    expect(finalFromVerdict('BLOCK')).toBe('BLOCK');
    expect(tighter('AUTO_APPROVE', 'HOLD')).toBe('HOLD');
    expect(tighter('HOLD', 'AUTO_APPROVE')).toBe('HOLD');
    expect(tighter('BLOCK', 'HOLD')).toBe('BLOCK');
    expect(tighter('AUTO_APPROVE', 'AUTO_APPROVE')).toBe('AUTO_APPROVE');
  });
});

describe('Guard.submit', () => {
  it('auto-approves a request inside the rules and records decision and audit', async () => {
    const { repo, guard } = setup();
    const result = await guard.submit(ok);

    expect(result.request.status).toBe('AUTO_APPROVED');
    expect(result.decision).toMatchObject({ policyVerdict: 'ALLOW', finalDecision: 'AUTO_APPROVE', decidedBy: 'policy', reviewRisk: 'low', reviewFlags: [] });
    expect(result.policy.budget).toMatchObject({ monthKey: '2026-10', spentMinor: 0, capMinor: 10000 });
    expect(result.review?.recommendation).toBe('AUTO_APPROVE');
    expect(result.payment).toBeNull();
    expect(repo.latestDecision(result.request.id)?.finalDecision).toBe('AUTO_APPROVE');
    expect(repo.listAudit({ requestId: result.request.id }).map((a) => `${a.actor} ${a.action}`)).toEqual(['system request.decided', 'agent:research-bot request.created']);
    // in flight: counts against the budget until captured (D10)
    expect(repo.spentThisMonthMinor('research-bot', NOON_JST, 'Asia/Tokyo')).toBe(1200);
  });

  it('holds a request outside the rules', async () => {
    const { guard } = setup();
    const result = await guard.submit({ ...ok, amountMinor: 3001 });
    expect(result.request.status).toBe('HELD');
    expect(result.decision.finalDecision).toBe('HOLD');
    expect(result.policy.reasons.map((r) => r.code)).toEqual(['OVER_TX_CAP']);
  });

  it('blocks on hard facts without consulting the reviewer', async () => {
    const reviewer = vi.fn(passthroughReviewer);
    const { guard } = setup({ reviewer });
    const result = await guard.submit({ ...ok, currency: 'EUR' });
    expect(result.request.status).toBe('BLOCKED');
    expect(result.decision.finalDecision).toBe('BLOCK');
    expect(result.review).toBeNull();
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('lets the reviewer tighten an approval into a hold, with its flags on record', async () => {
    const reviewer: Reviewer = async () => ({ risk: 'high', flags: ['PROMPT_INJECTION'], explanation: 'the page says to raise the limit', recommendation: 'HOLD' });
    const { guard } = setup({ reviewer });
    const result = await guard.submit(ok);
    expect(result.request.status).toBe('HELD');
    expect(result.decision).toMatchObject({ policyVerdict: 'ALLOW', finalDecision: 'HOLD', decidedBy: 'reviewer', reviewRisk: 'high', reviewFlags: ['PROMPT_INJECTION'] });
  });

  it('never lets the reviewer loosen a hold', async () => {
    const reviewer: Reviewer = async () => ({ risk: 'low', flags: [], explanation: 'looks fine to me', recommendation: 'AUTO_APPROVE' });
    const { guard } = setup({ reviewer });
    const result = await guard.submit({ ...ok, merchant: 'Unknown Shop' });
    expect(result.request.status).toBe('HELD');
    expect(result.decision.decidedBy).toBe('policy');
  });

  it('holds when the reviewer fails, and says so', async () => {
    const reviewer: Reviewer = async () => {
      throw new Error('provider down');
    };
    const { guard } = setup({ reviewer });
    const result = await guard.submit(ok);
    expect(result.request.status).toBe('HELD');
    expect(result.decision).toMatchObject({ finalDecision: 'HOLD', decidedBy: 'reviewer', reviewRisk: null, reviewFlags: ['REVIEWER_UNAVAILABLE'] });
    expect(result.decision.reviewExplanation).toContain('provider down');
  });

  it('holds when the reviewer times out and aborts it', async () => {
    let aborted = false;
    const reviewer: Reviewer = (_input, signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => (aborted = true));
      });
    const { guard } = setup({ reviewer, reviewTimeoutMs: 20 });
    const result = await guard.submit(ok);
    expect(result.request.status).toBe('HELD');
    expect(result.decision.reviewExplanation).toContain('timed out');
    expect(aborted).toBe(true);
  });

  it('refuses to decide a request twice', async () => {
    const { guard } = setup();
    const result = await guard.submit(ok);
    await expect(guard.decide(result.request.id)).rejects.toThrow('already decided');
    await expect(guard.decide('req_nope')).rejects.toThrow('unknown request');
  });

  it('counts approved requests against the budget for the next decision', async () => {
    const { guard } = setup();
    await guard.submit({ ...ok, amountMinor: 3000 });
    await guard.submit({ ...ok, amountMinor: 3000 });
    await guard.submit({ ...ok, amountMinor: 3000 });
    const fourth = await guard.submit({ ...ok, amountMinor: 1001 });
    expect(fourth.request.status).toBe('HELD');
    expect(fourth.policy.reasons.map((r) => r.code)).toEqual(['OVER_MONTHLY_BUDGET']);
    expect(fourth.policy.budget).toMatchObject({ spentMinor: 9000, remainingMinor: 1000 });
  });

  it('charges through the executor when auto-approved, and only then', async () => {
    const { charge, executor } = fakeExecutor();
    const { guard } = setup({ executor });
    const approved = await guard.submit(ok);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith(approved.request.id);
    expect(approved.payment?.status).toBe('COMPLETED');

    const held = await guard.submit({ ...ok, amountMinor: 3001 });
    expect(held.payment).toBeNull();
    expect(charge).toHaveBeenCalledTimes(1);
  });
});

describe('owner decisions on held requests', () => {
  it('approve moves HELD to APPROVED and charges when an executor is present', async () => {
    const { charge, executor } = fakeExecutor();
    const { repo, guard } = setup({ executor });
    const held = await guard.submit({ ...ok, amountMinor: 3001 });
    const { payment } = await guard.approve(held.request.id, 'owner');
    expect(charge).toHaveBeenCalledWith(held.request.id);
    expect(payment?.status).toBe('COMPLETED');
    expect(repo.listAudit({ requestId: held.request.id })[0]).toMatchObject({ actor: 'owner', action: 'owner.approved' });
  });

  it('approve without an executor leaves the request APPROVED (in flight)', async () => {
    const { repo, guard } = setup();
    const held = await guard.submit({ ...ok, amountMinor: 3001 });
    const { request, payment } = await guard.approve(held.request.id);
    expect(request.status).toBe('APPROVED');
    expect(payment).toBeNull();
    expect(repo.spentThisMonthMinor('research-bot', NOON_JST, 'Asia/Tokyo')).toBe(3001);
  });

  it('deny moves HELD to DENIED with the owner note on record', async () => {
    const { repo, guard } = setup();
    const held = await guard.submit({ ...ok, amountMinor: 3001 });
    const denied = guard.deny(held.request.id, 'owner', 'too expensive');
    expect(denied.status).toBe('DENIED');
    expect(repo.listAudit({ requestId: held.request.id })[0]).toMatchObject({ action: 'owner.denied', details: { note: 'too expensive' } });
    expect(repo.spentThisMonthMinor('research-bot', NOON_JST, 'Asia/Tokyo')).toBe(0);
  });

  it('only HELD requests can be approved or denied', async () => {
    const { guard } = setup();
    const auto = await guard.submit(ok);
    await expect(guard.approve(auto.request.id)).rejects.toThrow('not HELD');
    expect(() => guard.deny(auto.request.id)).toThrow('not HELD');
    expect(() => guard.deny('req_nope')).toThrow('unknown request');
  });
});
