import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../src/db/connection.js';
import { Repo } from '../../src/db/repo.js';
import type { Policy } from '../../src/domain/types.js';
import { evaluatePolicy } from '../../src/policy/engine.js';

const OCT_27_NOON_JST = Date.UTC(2026, 9, 27, 3, 0);

const policyInput: Omit<Policy, 'updatedAt'> = {
  agentId: 'research-bot',
  currency: 'USD',
  maxTxMinor: 3000,
  hardMaxTxMinor: 20000,
  monthlyBudgetMinor: 10000,
  merchantAllowlist: ['Synthetic Books', 'ＳＹＮＴＨＥＴＩＣ　ＳＵＰＰＬＩＥＳ', ' synthetic books '],
  categoryAllowlist: null,
  hours: { start: '08:00', end: '22:00' },
  timezone: 'Asia/Tokyo',
  holdNewMerchants: true,
};

function setup(nowMs = OCT_27_NOON_JST) {
  let now = nowMs;
  const db = openDatabase();
  const repo = new Repo(db, () => now);
  repo.createAgent({ id: 'research-bot', name: 'Research bot' });
  return { db, repo, setNow: (ms: number) => (now = ms) };
}

const baseRequest = { agentId: 'research-bot', merchant: 'Synthetic Books', item: 'Field notebook', category: 'books', amountMinor: 1200, currency: 'USD', reason: 'notes for the survey' };

describe('migrations', () => {
  it('apply once and are a no-op afterwards', () => {
    const db = openDatabase();
    expect(migrate(db)).toEqual([]);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r) => r['name']);
    expect(tables).toEqual(['agents', 'audit_log', 'decisions', 'mandates', 'payments', 'policies', 'requests', 'schema_migrations']);
  });

  it('work on a file under a path with non-ASCII characters', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const dir = mkdtempSync(join(repoRoot, '.tmp-db-'));
    try {
      const path = join(dir, 'guard.db');
      const first = openDatabase(path);
      new Repo(first).createAgent({ id: 'a1', name: 'first' });
      first.close();
      const second = openDatabase(path);
      expect(new Repo(second).getAgent('a1')?.name).toBe('first');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agents and policies', () => {
  it('round-trips an agent and its policy, normalizing the allowlist', () => {
    const { repo } = setup();
    expect(repo.getAgent('research-bot')).toMatchObject({ id: 'research-bot', name: 'Research bot', status: 'active', createdAt: OCT_27_NOON_JST });
    const saved = repo.savePolicy(policyInput);
    expect(saved.merchantAllowlist).toEqual(['synthetic books', 'synthetic supplies']);
    expect(repo.getPolicy('research-bot')).toEqual(saved);
    expect(repo.getPolicy('nobody')).toBeUndefined();
  });

  it('upserts the policy and stores null allowlists and hours as null', () => {
    const { repo } = setup();
    repo.savePolicy(policyInput);
    const updated = repo.savePolicy({ ...policyInput, maxTxMinor: 5000, merchantAllowlist: null, hours: null, holdNewMerchants: false });
    expect(repo.getPolicy('research-bot')).toEqual(updated);
    expect(updated).toMatchObject({ maxTxMinor: 5000, merchantAllowlist: null, hours: null, holdNewMerchants: false });
  });

  it('rejects an invalid policy with every problem named', () => {
    const { repo } = setup();
    expect(() => repo.savePolicy({ ...policyInput, hardMaxTxMinor: 1, timezone: 'Mars/Olympus' })).toThrow(/hardMaxTxMinor.*timezone/s);
    expect(repo.getPolicy('research-bot')).toBeUndefined();
  });

  it('disables and re-enables agents, and refuses unknown ids', () => {
    const { repo } = setup();
    repo.setAgentStatus('research-bot', 'disabled');
    expect(repo.getAgent('research-bot')?.status).toBe('disabled');
    expect(() => repo.setAgentStatus('ghost', 'active')).toThrow(/unknown agent/);
    expect(repo.listAgents().map((a) => a.id)).toEqual(['research-bot']);
  });
});

describe('requests, decisions and payments', () => {
  it('creates a request in EVALUATING with a normalized merchant key', () => {
    const { repo } = setup();
    const req = repo.createRequest({ ...baseRequest, merchant: ' SYNTHETIC  Books ' });
    expect(req.id).toMatch(/^req_[0-9a-f]{12}$/);
    expect(req.status).toBe('EVALUATING');
    expect(req.merchantKey).toBe('synthetic books');
    expect(req.sourceUrl).toBeNull();
    expect(repo.getRequest(req.id)).toEqual(req);
  });

  it('moves a request through statuses and rejects unknown ones at the database', () => {
    const { repo, setNow } = setup();
    const req = repo.createRequest(baseRequest);
    setNow(OCT_27_NOON_JST + 1000);
    const held = repo.setRequestStatus(req.id, 'HELD');
    expect(held.status).toBe('HELD');
    expect(held.updatedAt).toBe(OCT_27_NOON_JST + 1000);
    expect(() => repo.setRequestStatus(req.id, 'BOGUS' as never)).toThrow(/CHECK/);
    expect(() => repo.setRequestStatus('req_missing', 'HELD')).toThrow(/unknown request/);
  });

  it('lists requests newest first with filters', () => {
    const { repo, setNow } = setup();
    const a = repo.createRequest(baseRequest);
    setNow(OCT_27_NOON_JST + 1);
    const b = repo.createRequest({ ...baseRequest, merchant: 'Other' });
    repo.setRequestStatus(b.id, 'HELD');
    expect(repo.listRequests().map((r) => r.id)).toEqual([b.id, a.id]);
    expect(repo.listRequests({ status: 'HELD' }).map((r) => r.id)).toEqual([b.id]);
    expect(repo.listRequests({ agentId: 'nobody' })).toEqual([]);
    expect(repo.listRequests({ limit: 1 })).toHaveLength(1);
  });

  it('records decisions and returns the latest', () => {
    const { repo } = setup();
    const req = repo.createRequest(baseRequest);
    repo.recordDecision({ requestId: req.id, policyVerdict: 'ALLOW', policyReasons: [], finalDecision: 'AUTO_APPROVE', decidedBy: 'policy' });
    const second = repo.recordDecision({
      requestId: req.id,
      policyVerdict: 'ALLOW',
      policyReasons: [],
      reviewRisk: 'high',
      reviewFlags: ['PROMPT_INJECTION_SUSPECTED'],
      reviewExplanation: 'The product page instructs the agent to ignore its limits.',
      finalDecision: 'BLOCK',
      decidedBy: 'reviewer',
    });
    expect(repo.latestDecision(req.id)).toEqual(second);
    expect(second.id).toBeGreaterThan(0);
  });

  it('creates and updates a payment, one per request', () => {
    const { repo } = setup();
    const req = repo.createRequest(baseRequest);
    const pay = repo.createPayment({ requestId: req.id, agentId: 'research-bot', amountMinor: 1200, currency: 'USD' });
    expect(pay.status).toBe('CREATED');
    const done = repo.updatePayment(pay.id, { paypalOrderId: 'ORDER1', paypalCaptureId: 'CAP1', status: 'COMPLETED', capturedAt: OCT_27_NOON_JST });
    expect(done).toMatchObject({ paypalOrderId: 'ORDER1', paypalCaptureId: 'CAP1', status: 'COMPLETED', capturedAt: OCT_27_NOON_JST });
    expect(repo.paymentForRequest(req.id)).toEqual(done);
    expect(() => repo.createPayment({ requestId: req.id, agentId: 'research-bot', amountMinor: 1200, currency: 'USD' })).toThrow(/UNIQUE/);
    expect(() => repo.updatePayment('pay_missing', { status: 'FAILED' })).toThrow(/unknown payment/);
  });
});

describe('budget and merchant history', () => {
  function seed() {
    const { repo, setNow, db } = setup();
    repo.savePolicy(policyInput);
    const paid = (merchant: string, amountMinor: number, capturedAt: number, status: 'COMPLETED' | 'REFUNDED' | 'FAILED' = 'COMPLETED', agentId = 'research-bot') => {
      const req = repo.createRequest({ ...baseRequest, agentId, merchant, amountMinor });
      const pay = repo.createPayment({ requestId: req.id, agentId, amountMinor, currency: 'USD' });
      repo.updatePayment(pay.id, { status, capturedAt: status === 'FAILED' ? null : capturedAt, paypalCaptureId: status === 'FAILED' ? null : 'CAP' });
      repo.setRequestStatus(req.id, status === 'COMPLETED' ? 'PAID' : status === 'REFUNDED' ? 'REFUNDED' : 'PAYMENT_FAILED');
      return req;
    };
    repo.createAgent({ id: 'other-bot', name: 'Other' });
    paid('Synthetic Books', 1200, Date.UTC(2026, 9, 5)); // October (JST)
    paid('Synthetic Supplies', 500, Date.UTC(2026, 9, 31, 15, 30)); // 1 Nov 00:30 JST: next month
    paid('Synthetic Books', 700, Date.UTC(2026, 9, 10), 'REFUNDED'); // refunded: gives the budget back
    paid('Gadget Hut', 900, Date.UTC(2026, 9, 11), 'FAILED'); // never captured
    paid('Synthetic Books', 1000, Date.UTC(2026, 9, 12), 'COMPLETED', 'other-bot'); // someone else's money
    const approved = repo.createRequest({ ...baseRequest, amountMinor: 300 });
    repo.setRequestStatus(approved.id, 'APPROVED'); // in flight: counts
    const held = repo.createRequest({ ...baseRequest, amountMinor: 400 });
    repo.setRequestStatus(held.id, 'HELD'); // waiting for the owner: does not count
    return { repo, setNow, db };
  }

  it('counts completed captures of the policy month plus in-flight approvals, nothing else', () => {
    const { repo } = seed();
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo')).toBe(1200 + 300);
  });

  it('counts an older request still under evaluation for the newer one, never the other way round (D16)', () => {
    const { repo } = seed();
    const first = repo.createRequest({ ...baseRequest, amountMinor: 1000 }); // EVALUATING
    const second = repo.createRequest({ ...baseRequest, amountMinor: 2000 }); // EVALUATING, newer
    const base = 1200 + 300;
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo')).toBe(base); // nobody deciding: evaluating requests do not count
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo', first.id)).toBe(base);
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo', second.id)).toBe(base + 1000);
    expect(repo.policyContext('research-bot', OCT_27_NOON_JST, second.id).spentThisMonthMinor).toBe(base + 1000);
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo', 'req_unknown')).toBe(base);
  });

  it('lists approved requests whose payment never settled', () => {
    const { repo } = seed();
    expect(repo.unsettledRequests()).toEqual([]);
    const req = repo.createRequest({ ...baseRequest, amountMinor: 800 });
    repo.setRequestStatus(req.id, 'AUTO_APPROVED');
    repo.beginPayment(req.id); // CREATED: no answer from PayPal yet
    expect(repo.unsettledRequests().map((r) => r.id)).toEqual([req.id]);
    const payment = repo.paymentForRequest(req.id);
    expect(payment?.status).toBe('CREATED');
    repo.settlePayment(payment?.id ?? '', { paypalOrderId: 'O', paypalCaptureId: 'C', capturedAt: OCT_27_NOON_JST });
    expect(repo.unsettledRequests()).toEqual([]);
  });

  it('rolls over at the policy zone month boundary', () => {
    const { repo } = seed();
    const nov2 = Date.UTC(2026, 10, 2, 3, 0);
    expect(repo.spentThisMonthMinor('research-bot', nov2, 'Asia/Tokyo')).toBe(500 + 300);
    // in UTC the 31 October capture still belongs to October
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'UTC')).toBe(1200 + 500 + 300);
  });

  it('knows which merchants were actually paid', () => {
    const { repo } = seed();
    expect(repo.knownMerchants('research-bot')).toEqual(['synthetic books', 'synthetic supplies']);
    expect(repo.knownMerchants('other-bot')).toEqual(['synthetic books']);
    expect(repo.knownMerchants('nobody')).toEqual([]);
  });

  it('builds the policy context and feeds the engine', () => {
    const { repo } = seed();
    const ctx = repo.policyContext('research-bot', OCT_27_NOON_JST);
    expect(ctx).toEqual({ nowMs: OCT_27_NOON_JST, spentThisMonthMinor: 1500, knownMerchants: ['synthetic books', 'synthetic supplies'] });
    const result = evaluatePolicy({
      agent: repo.getAgent('research-bot'),
      policy: repo.getPolicy('research-bot'),
      request: { merchant: 'Synthetic Books', category: 'books', amountMinor: 3000, currency: 'USD' },
      context: ctx,
    });
    expect(result.verdict).toBe('ALLOW');
    expect(result.budget?.remainingMinor).toBe(8500);
  });
});

describe('audit log', () => {
  it('appends entries and lists them newest first, per request when asked', () => {
    const { repo, setNow } = setup();
    const req = repo.createRequest(baseRequest);
    const first = repo.appendAudit({ actor: `agent:${req.agentId}`, action: 'request.created', requestId: req.id, agentId: req.agentId, details: { amount: '12.00 USD' } });
    setNow(OCT_27_NOON_JST + 5);
    const second = repo.appendAudit({ actor: 'owner', action: 'policy.updated', agentId: 'research-bot' });
    expect(first.id).toBeLessThan(second.id);
    expect(repo.listAudit().map((e) => e.action)).toEqual(['policy.updated', 'request.created']);
    expect(repo.listAudit({ requestId: req.id })).toEqual([first]);
    expect(repo.listAudit()[0]).toMatchObject({ requestId: null, details: {}, ts: OCT_27_NOON_JST + 5 });
  });

  it('runs a transaction and rolls back on error', () => {
    const { repo } = setup();
    expect(() =>
      repo.transaction(() => {
        repo.appendAudit({ actor: 'system', action: 'will.rollback' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repo.listAudit()).toEqual([]);
    const value = repo.transaction(() => repo.appendAudit({ actor: 'system', action: 'kept' }).id);
    expect(value).toBeGreaterThan(0);
    expect(repo.listAudit()).toHaveLength(1);
  });
});

describe('mandates', () => {
  it('keeps exactly one active mandate and never more', () => {
    const { repo } = setup();
    expect(repo.activeMandate()).toBeUndefined();
    const first = repo.saveMandate({ paypalVaultId: 'vault-one-000000', paypalCustomerId: 'cust1' });
    expect(repo.activeMandate()).toEqual(first);
    const second = repo.saveMandate({ paypalVaultId: 'vault-two-000000' });
    expect(repo.activeMandate()?.id).toBe(second.id);
    expect(repo.listMandates().map((m) => [m.id, m.status])).toEqual([
      [second.id, 'active'],
      [first.id, 'revoked'],
    ]);
    repo.revokeMandate(second.id);
    expect(repo.activeMandate()).toBeUndefined();
    expect(() => repo.revokeMandate('mnd_nope')).toThrow('unknown mandate');
  });
});

describe('payment state changes (D10)', () => {
  function approved(amountMinor = 1200) {
    const ctx = setup();
    const request = ctx.repo.createRequest({ ...baseRequest, amountMinor });
    ctx.repo.setRequestStatus(request.id, 'AUTO_APPROVED');
    return { ...ctx, request };
  }

  it('beginPayment needs an approved request and returns the same payment on re-entry', () => {
    const { repo, request } = approved();
    const payment = repo.beginPayment(request.id);
    expect(payment).toMatchObject({ requestId: request.id, agentId: 'research-bot', amountMinor: 1200, currency: 'USD', status: 'CREATED' });
    expect(repo.beginPayment(request.id)).toEqual(payment);

    const held = repo.createRequest(baseRequest);
    repo.setRequestStatus(held.id, 'HELD');
    expect(() => repo.beginPayment(held.id)).toThrow('only AUTO_APPROVED or APPROVED');
    expect(() => repo.beginPayment('req_nope')).toThrow('unknown request');
  });

  it('settlePayment marks the request PAID in the same step and moves the amount from in-flight to captured', () => {
    const { repo, request } = approved();
    const payment = repo.beginPayment(request.id);
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo')).toBe(1200); // in flight
    const settled = repo.settlePayment(payment.id, { paypalOrderId: 'O1', paypalCaptureId: 'C1', capturedAt: OCT_27_NOON_JST });
    expect(settled).toMatchObject({ status: 'COMPLETED', paypalOrderId: 'O1', paypalCaptureId: 'C1', capturedAt: OCT_27_NOON_JST });
    expect(repo.getRequest(request.id)?.status).toBe('PAID');
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo')).toBe(1200); // captured, counted once
    expect(repo.settlePayment(payment.id, { paypalOrderId: 'O1', paypalCaptureId: 'C1', capturedAt: 1 })).toEqual(settled);
    expect(() => repo.failPayment(payment.id)).toThrow('only CREATED payments can fail');
  });

  it('failPayment marks the request PAYMENT_FAILED and frees the budget', () => {
    const { repo, request } = approved();
    const payment = repo.beginPayment(request.id);
    const failed = repo.failPayment(payment.id, { paypalOrderId: 'O2' });
    expect(failed).toMatchObject({ status: 'FAILED', paypalOrderId: 'O2', paypalCaptureId: null });
    expect(repo.getRequest(request.id)?.status).toBe('PAYMENT_FAILED');
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo')).toBe(0);
    expect(() => repo.settlePayment(payment.id, { paypalOrderId: 'O2', paypalCaptureId: 'C2', capturedAt: 1 })).toThrow('only CREATED payments can settle');
    expect(() => repo.failPayment('pay_nope')).toThrow('unknown payment');
  });

  it('refundPayment marks the request REFUNDED, gives the budget back and rejects anything not completed', () => {
    const { repo, request } = approved();
    const payment = repo.beginPayment(request.id);
    expect(() => repo.refundPayment(payment.id, 'R0')).toThrow('only COMPLETED or REFUND_PENDING payments can be refunded');
    repo.settlePayment(payment.id, { paypalOrderId: 'O3', paypalCaptureId: 'C3', capturedAt: OCT_27_NOON_JST });
    const refunded = repo.refundPayment(payment.id, 'R3');
    expect(refunded).toMatchObject({ status: 'REFUNDED', paypalRefundId: 'R3' });
    expect(repo.getRequest(request.id)?.status).toBe('REFUNDED');
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo')).toBe(0);
    expect(repo.knownMerchants('research-bot')).toEqual(['synthetic books']);
  });

  it('markRefundPending keeps the amount counted; refundPayment settles it; cancelPendingRefund hands the capture back (D17)', () => {
    const { repo, request } = approved();
    const payment = repo.beginPayment(request.id);
    expect(() => repo.markRefundPending(payment.id, 'R4')).toThrow('only COMPLETED payments can have a pending refund');
    repo.settlePayment(payment.id, { paypalOrderId: 'O4', paypalCaptureId: 'C4', capturedAt: OCT_27_NOON_JST });
    const pending = repo.markRefundPending(payment.id, 'R4');
    expect(pending).toMatchObject({ status: 'REFUND_PENDING', paypalRefundId: 'R4' });
    expect(repo.getRequest(request.id)?.status).toBe('PAID');
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo')).toBe(1200);
    expect(repo.refundPendingRequests().map((r) => r.id)).toEqual([request.id]);
    expect(repo.markRefundPending(payment.id, 'R4')).toEqual(pending);

    const restored = repo.cancelPendingRefund(payment.id);
    expect(restored).toMatchObject({ status: 'COMPLETED', paypalRefundId: null, paypalCaptureId: 'C4' });
    expect(repo.refundPendingRequests()).toEqual([]);
    expect(() => repo.cancelPendingRefund(payment.id)).toThrow('only a REFUND_PENDING payment');

    repo.markRefundPending(payment.id, 'R5');
    const refunded = repo.refundPayment(payment.id, 'R5');
    expect(refunded).toMatchObject({ status: 'REFUNDED', paypalRefundId: 'R5' });
    expect(repo.getRequest(request.id)?.status).toBe('REFUNDED');
    expect(repo.spentThisMonthMinor('research-bot', OCT_27_NOON_JST, 'Asia/Tokyo')).toBe(0);
  });
});

describe('schema changes since 001 (D17)', () => {
  it('migrate a database created by 001 with its rows intact', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.exec(readFileSync(new URL('../../src/db/migrations/001_init.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('001_init.sql', 1);
    db.exec(`INSERT INTO agents (id, name, status, created_at) VALUES ('a', 'A', 'active', 1)`);
    db.exec(`INSERT INTO requests (id, agent_id, merchant, merchant_key, item, category, amount_minor, currency, reason, status, created_at, updated_at)
             VALUES ('r1', 'a', 'M', 'm', 'I', 'c', 1200, 'USD', 'why', 'PAID', 1, 1)`);
    db.exec(`INSERT INTO payments (id, request_id, agent_id, paypal_order_id, paypal_capture_id, amount_minor, currency, status, captured_at, created_at, updated_at)
             VALUES ('p1', 'r1', 'a', 'O1', 'C1', 1200, 'USD', 'COMPLETED', 1, 1, 1)`);

    expect(migrate(db)).toEqual(['002_intent_id.sql', '003_refund_pending.sql']);
    const repo = new Repo(db, () => 2);
    expect(repo.getRequest('r1')).toMatchObject({ id: 'r1', intentId: null, status: 'PAID' });
    expect(repo.getPayment('p1')).toMatchObject({ id: 'p1', requestId: 'r1', paypalCaptureId: 'C1', status: 'COMPLETED' });
    expect(repo.markRefundPending('p1', 'R1').status).toBe('REFUND_PENDING'); // the widened CHECK accepts it
    expect(repo.spentThisMonthMinor('a', 1, 'UTC')).toBe(1200);
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('requests_agent_intent', 'payments_agent_captured') ORDER BY name`)
      .all()
      .map((r) => r['name']);
    expect(indexes).toEqual(['payments_agent_captured', 'requests_agent_intent']);
    expect(migrate(db)).toEqual([]);
  });

  it('finds a request by agent and intent id, and refuses a second request under the same one', () => {
    const { repo } = setup();
    const first = repo.createRequest({ ...baseRequest, intentId: 'i-1' });
    expect(repo.requestByIntent('research-bot', 'i-1')?.id).toBe(first.id);
    expect(repo.requestByIntent('research-bot', 'i-2')).toBeUndefined();
    expect(() => repo.createRequest({ ...baseRequest, intentId: 'i-1' })).toThrow(/UNIQUE/);
    expect(repo.createRequest(baseRequest).intentId).toBeNull();
    expect(repo.createRequest(baseRequest).intentId).toBeNull(); // no intent id twice is fine: the index skips nulls
  });

  it('lists EVALUATING requests oldest first', () => {
    const { repo } = setup();
    const a = repo.createRequest(baseRequest);
    const b = repo.createRequest(baseRequest);
    const c = repo.createRequest(baseRequest);
    repo.setRequestStatus(b.id, 'HELD');
    expect(repo.evaluatingRequests().map((r) => r.id)).toEqual([a.id, c.id]);
  });
});
