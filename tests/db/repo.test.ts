import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
