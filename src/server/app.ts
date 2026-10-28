/**
 * The guard server: owner dashboard (server-rendered HTML, a little JS), the JSON API agents use through the MCP
 * server, and an SSE stream that refreshes open dashboards. Every request field (merchant, item, reason, URL) is
 * untrusted text and is only ever interpolated through hono/html, which escapes it.
 */
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Repo } from '../db/repo.js';
import { formatAmount, parseAmount } from '../domain/money.js';
import type { Agent, AuditEntry, Decision, Mandate, Payment, Policy, PurchaseRequest, RequestStatus } from '../domain/types.js';
import type { PayPalExecutor } from '../guard/executor.js';
import type { Guard } from '../guard/pipeline.js';
import type { PayPalClient } from '../paypal/client.js';
import { createPaymentToken, createSetupToken, getSetupToken } from '../paypal/vault.js';
import { monthBounds } from '../policy/time.js';
import { validatePolicy } from '../policy/validate.js';
import type { EventBus } from './events.js';

export interface AppDeps {
  repo: Repo;
  guard: Guard;
  events: EventBus;
  /** Absent in keyless mode: decisions are made but nothing is charged. */
  executor?: PayPalExecutor;
  /** Absent in keyless mode: the Link PayPal flow is disabled. */
  paypal?: PayPalClient;
  /** Where PayPal sends the owner back after approving the mandate, e.g. http://localhost:3000. */
  publicBaseUrl: string;
  shopUrl: string;
  now?: () => number;
  /** SSE keep-alive interval. */
  heartbeatMs?: number;
}

// ------------------------------------------------------------------ API schema

const requestSchema = z.object({
  agent_id: z.string().min(1).max(64),
  merchant: z.string().min(1).max(200),
  item: z.string().min(1).max(500),
  category: z.string().min(1).max(100),
  amount: z.union([z.string(), z.number()]),
  currency: z.string().length(3),
  reason: z.string().max(2000),
  source_url: z.string().max(2000).nullable().optional(),
});

function toMinor(amount: string | number): number | undefined {
  if (typeof amount === 'number') return Number.isFinite(amount) && amount > 0 ? parseAmount(amount.toFixed(2)) : undefined;
  return parseAmount(amount.trim());
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ view models

const MESSAGES: Record<RequestStatus, string> = {
  EVALUATING: 'Being evaluated.',
  AUTO_APPROVED: 'Approved by policy; the charge is in progress.',
  HELD: 'Held for the owner. Poll get_request_status for their decision; do not retry the purchase.',
  BLOCKED: 'Blocked by policy. Do not retry.',
  APPROVED: 'The owner approved it; the charge is in progress.',
  DENIED: 'The owner denied it. Do not retry.',
  PAID: 'Paid. The owner can refund it from the dashboard.',
  PAYMENT_FAILED: 'Approved, but the payment failed. The owner has been notified.',
  REFUNDED: 'Refunded by the owner.',
};

export function requestView(repo: Repo, request: PurchaseRequest) {
  const decision = repo.latestDecision(request.id);
  const payment = repo.paymentForRequest(request.id);
  const reasons = decision?.policyReasons ?? [];
  return {
    request_id: request.id,
    agent_id: request.agentId,
    status: request.status,
    merchant: request.merchant,
    item: request.item,
    category: request.category,
    amount: formatAmount(request.amountMinor),
    currency: request.currency,
    reason: request.reason,
    source_url: request.sourceUrl,
    created_at: new Date(request.createdAt).toISOString(),
    decision: decision
      ? {
          final: decision.finalDecision,
          policy_verdict: decision.policyVerdict,
          reasons: reasons.map((r) => ({ code: r.code, message: r.message })),
          review: decision.reviewRisk === null && decision.reviewFlags.length === 0 ? null : { risk: decision.reviewRisk, flags: decision.reviewFlags, explanation: decision.reviewExplanation },
          decided_by: decision.decidedBy,
        }
      : null,
    payment: payment ? { status: payment.status, paypal_order_id: payment.paypalOrderId, paypal_capture_id: payment.paypalCaptureId, paypal_refund_id: payment.paypalRefundId } : null,
    message: `${MESSAGES[request.status]}${reasons.length > 0 ? ` Reasons: ${reasons.map((r) => r.message).join('; ')}` : ''}`,
  };
}

export function budgetView(repo: Repo, agent: Agent, nowMs: number) {
  const policy = repo.getPolicy(agent.id);
  if (!policy) return { agent_id: agent.id, status: agent.status, policy: null };
  const { key } = monthBounds(nowMs, policy.timezone);
  const spent = repo.spentThisMonthMinor(agent.id, nowMs, policy.timezone);
  return {
    agent_id: agent.id,
    status: agent.status,
    policy: {
      currency: policy.currency,
      max_per_purchase: formatAmount(policy.maxTxMinor),
      hard_max_per_purchase: policy.hardMaxTxMinor === null ? null : formatAmount(policy.hardMaxTxMinor),
      monthly_budget: formatAmount(policy.monthlyBudgetMinor),
      merchant_allowlist: policy.merchantAllowlist,
      category_allowlist: policy.categoryAllowlist,
      hours: policy.hours,
      timezone: policy.timezone,
      hold_new_merchants: policy.holdNewMerchants,
    },
    month: key,
    spent: formatAmount(spent),
    remaining: formatAmount(Math.max(0, policy.monthlyBudgetMinor - spent)),
  };
}

// ------------------------------------------------------------------ HTML helpers

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f4f6fa; color: #1b1f27; }
  header { background: #0f172a; color: #fff; padding: 12px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header a { color: #cbd5e1; text-decoration: none; } header a:hover { color: #fff; }
  header .brand { font-weight: 700; color: #fff; }
  header .live { margin-left: auto; font-size: 12px; color: #94a3b8; }
  main { max-width: 960px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 22px; margin: 8px 0 12px; } h2 { font-size: 17px; margin: 20px 0 8px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; margin: 10px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eef1f5; vertical-align: top; }
  th { font-weight: 600; color: #475569; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #e2e8f0; color: #334155; white-space: nowrap; }
  .badge.ok { background: #dcfce7; color: #166534; } .badge.hold { background: #fef3c7; color: #92400e; }
  .badge.bad { background: #fee2e2; color: #991b1b; } .badge.info { background: #dbeafe; color: #1e40af; }
  .bar { height: 10px; background: #e2e8f0; border-radius: 999px; overflow: hidden; margin: 6px 0; }
  .bar > div { height: 100%; background: #2563eb; }
  .muted { color: #64748b; font-size: 13px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  button, .btn { border: 0; border-radius: 8px; padding: 9px 14px; font-size: 14px; font-weight: 600; cursor: pointer; background: #2563eb; color: #fff; text-decoration: none; display: inline-block; }
  button.deny { background: #dc2626; } button.ghost { background: #e2e8f0; color: #1e293b; }
  input, select { font: inherit; padding: 8px; border: 1px solid #cbd5e1; border-radius: 8px; width: 100%; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; font-size: 13px; }
  .notice { background: #ecfdf5; border: 1px solid #a7f3d0; padding: 10px 14px; border-radius: 8px; margin: 10px 0; }
  .error { background: #fef2f2; border: 1px solid #fecaca; padding: 10px 14px; border-radius: 8px; margin: 10px 0; }
  .reason { background: #fff7ed; border-left: 3px solid #f59e0b; padding: 6px 10px; margin: 6px 0; font-size: 14px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f8fafc; padding: 8px; border-radius: 6px; font-size: 12px; }
  .mono { font-family: ui-monospace, monospace; font-size: 13px; }
  .wrap { word-break: break-word; }
  @media (max-width: 600px) { th:nth-child(n+5), td:nth-child(n+5) { display: none; } main { padding: 10px; } }
`;

const LIVE_JS = `
  (function () {
    var dot = document.getElementById('live');
    try {
      var es = new EventSource('/events'); var t;
      es.addEventListener('guard', function () { clearTimeout(t); t = setTimeout(function () { location.reload(); }, 250); });
      es.onopen = function () { if (dot) dot.textContent = 'live'; };
      es.onerror = function () { if (dot) dot.textContent = 'reconnecting…'; };
    } catch (e) { if (dot) dot.textContent = 'no live updates'; }
  })();
`;

type Html = ReturnType<typeof html>;

function layout(title: string, body: unknown, opts: { shopUrl: string; live?: boolean }): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · agent-spend-guard</title>
<style>${raw(CSS)}</style>
</head>
<body>
<header>
  <a class="brand" href="/">agent-spend-guard</a>
  <a href="/">Overview</a>
  <a href="/audit">Audit log</a>
  <a href="/paypal">PayPal</a>
  <a href="${opts.shopUrl}" target="_blank" rel="noopener noreferrer">Synthetic shop ↗</a>
  <span class="live" id="live">${opts.live === false ? 'sandbox' : 'connecting…'}</span>
</header>
<main>${body}</main>
${opts.live === false ? '' : html`<script>${raw(LIVE_JS)}</script>`}
</body>
</html>`;
}

const BADGE_CLASS: Record<RequestStatus, string> = {
  EVALUATING: 'info',
  AUTO_APPROVED: 'ok',
  HELD: 'hold',
  BLOCKED: 'bad',
  APPROVED: 'ok',
  DENIED: 'bad',
  PAID: 'ok',
  PAYMENT_FAILED: 'bad',
  REFUNDED: 'info',
};

const badge = (status: RequestStatus): Html => html`<span class="badge ${BADGE_CLASS[status]}">${status}</span>`;
const money = (minor: number, currency: string): string => `${formatAmount(minor)} ${currency}`;
const when = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

function requestRow(r: PurchaseRequest): Html {
  return html`<tr>
  <td><a href="/requests/${r.id}" class="mono">${r.id}</a></td>
  <td>${badge(r.status)}</td>
  <td class="wrap">${r.merchant}<div class="muted">${r.item}</div></td>
  <td>${money(r.amountMinor, r.currency)}</td>
  <td>${r.agentId}</td>
  <td class="muted">${when(r.createdAt)}</td>
</tr>`;
}

function requestTable(rows: PurchaseRequest[], empty: string): Html {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<table>
<thead><tr><th>Request</th><th>Status</th><th>Merchant / item</th><th>Amount</th><th>Agent</th><th>Created</th></tr></thead>
<tbody>${rows.map(requestRow)}</tbody>
</table>`;
}

function decisionBlock(decision: Decision | undefined): Html {
  if (!decision) return html`<p class="muted">No decision yet.</p>`;
  return html`<p>Policy said <strong>${decision.policyVerdict}</strong>; final decision <strong>${decision.finalDecision}</strong> (by ${decision.decidedBy}).</p>
${decision.policyReasons.map((r) => html`<div class="reason"><strong>${r.code}</strong> ${r.message}</div>`)}
${
  decision.reviewRisk === null && decision.reviewFlags.length === 0
    ? ''
    : html`<p>AI review: risk <strong>${decision.reviewRisk ?? 'n/a'}</strong>${decision.reviewFlags.length > 0 ? html`, flags ${decision.reviewFlags.join(', ')}` : ''}.<br><span class="muted">${decision.reviewExplanation ?? ''}</span></p>`
}`;
}

function paymentBlock(payment: Payment | undefined): Html {
  if (!payment) return html`<p class="muted">No PayPal payment for this request.</p>`;
  return html`<table>
<tr><th>Payment</th><td class="mono">${payment.id}</td></tr>
<tr><th>Status</th><td>${payment.status}</td></tr>
<tr><th>PayPal order</th><td class="mono">${payment.paypalOrderId ?? '—'}</td></tr>
<tr><th>Capture</th><td class="mono">${payment.paypalCaptureId ?? '—'}</td></tr>
<tr><th>Refund</th><td class="mono">${payment.paypalRefundId ?? '—'}</td></tr>
<tr><th>Captured at</th><td>${payment.capturedAt === null ? '—' : when(payment.capturedAt)}</td></tr>
</table>`;
}

function auditTable(entries: AuditEntry[]): Html {
  if (entries.length === 0) return html`<p class="muted">Nothing logged yet.</p>`;
  return html`<table>
<thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Request</th><th>Details</th></tr></thead>
<tbody>${entries.map(
    (e) => html`<tr>
  <td class="muted">${when(e.ts)}</td>
  <td>${e.actor}</td>
  <td class="mono">${e.action}</td>
  <td>${e.requestId ? html`<a href="/requests/${e.requestId}" class="mono">${e.requestId}</a>` : '—'}</td>
  <td><pre>${JSON.stringify(e.details)}</pre></td>
</tr>`,
  )}</tbody>
</table>`;
}

function policySummary(policy: Policy | undefined): Html {
  if (!policy) return html`<p class="error">No policy: every request is blocked.</p>`;
  return html`<ul class="muted" style="margin:6px 0 0 18px;padding:0">
  <li>Up to ${money(policy.maxTxMinor, policy.currency)} per purchase${policy.hardMaxTxMinor === null ? '' : html`, never above ${money(policy.hardMaxTxMinor, policy.currency)}`}</li>
  <li>${money(policy.monthlyBudgetMinor, policy.currency)} per calendar month (${policy.timezone})</li>
  <li>Merchants: ${policy.merchantAllowlist === null ? (policy.holdNewMerchants ? 'any, first purchase at a new merchant is held' : 'any') : policy.merchantAllowlist.join(', ')}</li>
  <li>Categories: ${policy.categoryAllowlist === null ? 'any' : policy.categoryAllowlist.join(', ')}</li>
  <li>Hours: ${policy.hours === null ? 'any time' : html`${policy.hours.start}–${policy.hours.end} ${policy.timezone}`}</li>
</ul>`;
}

// ------------------------------------------------------------------ the app

export function createApp(deps: AppDeps): Hono {
  const { repo, guard, events, executor, paypal } = deps;
  const now = deps.now ?? Date.now;
  const page = (title: string, body: unknown, live = true) => layout(title, body, { shopUrl: deps.shopUrl, live });
  const pendingLinks = new Map<string, { setupTokenId: string; createdAt: number }>();
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  const publishRequest = (type: string, request: PurchaseRequest): void => {
    events.publish({ type, requestId: request.id, agentId: request.agentId, status: request.status, at: now() });
  };

  // -------------------------------------------------------------- dashboard

  app.get('/', (c) => {
    const nowMs = now();
    const agents = repo.listAgents();
    const held = repo.listRequests({ status: 'HELD', limit: 50 });
    const recent = repo.listRequests({ limit: 20 });
    const mandate = repo.activeMandate();
    const body = html`<h1>Overview</h1>
${executor ? '' : html`<div class="notice">Keyless mode: requests are decided but nothing is charged (no PayPal sandbox credentials in .env).</div>`}
${mandate ? '' : html`<div class="error">PayPal is not linked yet: approved requests cannot be charged. <a href="/paypal">Link PayPal (sandbox)</a></div>`}
<div class="grid">
${agents.map((a) => {
  const policy = repo.getPolicy(a.id);
  const spent = policy ? repo.spentThisMonthMinor(a.id, nowMs, policy.timezone) : 0;
  const pct = policy ? Math.min(100, Math.round((spent / policy.monthlyBudgetMinor) * 100)) : 0;
  return html`<div class="card">
  <strong>${a.name}</strong> <span class="muted mono">${a.id}</span> <span class="badge ${a.status === 'active' ? 'ok' : 'bad'}">${a.status}</span>
  ${policy ? html`<div class="bar"><div style="width:${pct}%"></div></div><div class="muted">${money(spent, policy.currency)} of ${money(policy.monthlyBudgetMinor, policy.currency)} this month (${monthBounds(nowMs, policy.timezone).key})</div>` : ''}
  ${policySummary(policy)}
  <p><a href="/policies/${a.id}">Edit rules</a></p>
</div>`;
})}
</div>
<h2>Waiting for you (${held.length})</h2>
${held.length === 0 ? html`<p class="muted">Nothing is waiting.</p>` : ''}
${held.map((r) => {
  const decision = repo.latestDecision(r.id);
  return html`<div class="card">
  <div class="actions"><strong>${money(r.amountMinor, r.currency)}</strong> at <strong class="wrap">${r.merchant}</strong> <span class="muted">by ${r.agentId}</span> ${badge(r.status)}</div>
  <div class="wrap">${r.item}</div>
  <div class="muted wrap">Agent's reason: “${r.reason}”</div>
  ${(decision?.policyReasons ?? []).map((reason) => html`<div class="reason"><strong>${reason.code}</strong> ${reason.message}</div>`)}
  <div class="actions" style="margin-top:8px">
    <form method="post" action="/requests/${r.id}/approve"><button type="submit">Approve &amp; pay</button></form>
    <form method="post" action="/requests/${r.id}/deny"><button type="submit" class="deny">Deny</button></form>
    <a class="btn ghost" href="/requests/${r.id}">Details</a>
  </div>
</div>`;
})}
<h2>Recent requests</h2>
${requestTable(recent, 'No requests yet. Run the demo agent.')}`;
    return c.html(page('Overview', body));
  });

  app.get('/requests/:id', (c) => {
    const request = repo.getRequest(c.req.param('id'));
    if (!request) return c.html(page('Not found', html`<h1>Unknown request</h1>`), 404);
    const decision = repo.latestDecision(request.id);
    const payment = repo.paymentForRequest(request.id);
    const audit = [...repo.listAudit({ requestId: request.id })].reverse();
    const url = safeUrl(request.sourceUrl);
    const notice = c.req.query('notice');
    const body = html`<h1>Request <span class="mono">${request.id}</span> ${badge(request.status)}</h1>
${notice ? html`<div class="notice">${notice}</div>` : ''}
<div class="card">
<table>
<tr><th>Agent</th><td>${request.agentId}</td></tr>
<tr><th>Merchant</th><td class="wrap">${request.merchant}</td></tr>
<tr><th>Item</th><td class="wrap">${request.item}</td></tr>
<tr><th>Category</th><td>${request.category}</td></tr>
<tr><th>Amount</th><td>${money(request.amountMinor, request.currency)}</td></tr>
<tr><th>Agent's reason</th><td class="wrap">${request.reason}</td></tr>
<tr><th>Source page</th><td class="wrap">${url ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>` : html`<span class="muted">${request.sourceUrl ?? '—'}</span>`}</td></tr>
<tr><th>Created</th><td>${when(request.createdAt)}</td></tr>
</table>
</div>
<div class="actions">
${request.status === 'HELD' ? html`<form method="post" action="/requests/${request.id}/approve"><button type="submit">Approve &amp; pay</button></form><form method="post" action="/requests/${request.id}/deny"><input type="hidden" name="note" value=""><button type="submit" class="deny">Deny</button></form>` : ''}
${request.status === 'PAID' && executor ? html`<form method="post" action="/requests/${request.id}/refund"><button type="submit" class="ghost">Refund</button></form>` : ''}
</div>
<h2>Decision</h2>
<div class="card">${decisionBlock(decision)}</div>
<h2>PayPal</h2>
<div class="card">${paymentBlock(payment)}</div>
<h2>Audit trail</h2>
<div class="card">${auditTable(audit)}</div>`;
    return c.html(page(`Request ${request.id}`, body));
  });

  app.post('/requests/:id/approve', async (c) => {
    const id = c.req.param('id');
    try {
      const { request, payment } = await guard.approve(id, 'owner');
      publishRequest('owner.approved', request);
      if (payment) publishRequest(payment.status === 'COMPLETED' ? 'payment.captured' : 'payment.failed', request);
      const notice = payment ? (payment.status === 'COMPLETED' ? `Approved and paid (capture ${payment.paypalCaptureId ?? '?'}).` : 'Approved, but the payment failed.') : 'Approved. Nothing was charged (keyless mode).';
      return c.redirect(`/requests/${id}?notice=${encodeURIComponent(notice)}`, 303);
    } catch (err) {
      return c.html(page('Error', html`<h1>Could not approve</h1><div class="error">${err instanceof Error ? err.message : String(err)}</div><p><a href="/requests/${id}">Back</a></p>`), 409);
    }
  });

  app.post('/requests/:id/deny', async (c) => {
    const id = c.req.param('id');
    const form = await c.req.parseBody();
    const note = typeof form['note'] === 'string' && form['note'].trim() !== '' ? form['note'].trim().slice(0, 500) : undefined;
    try {
      const request = guard.deny(id, 'owner', note);
      publishRequest('owner.denied', request);
      return c.redirect(`/requests/${id}?notice=${encodeURIComponent('Denied.')}`, 303);
    } catch (err) {
      return c.html(page('Error', html`<h1>Could not deny</h1><div class="error">${err instanceof Error ? err.message : String(err)}</div><p><a href="/requests/${id}">Back</a></p>`), 409);
    }
  });

  app.post('/requests/:id/refund', async (c) => {
    const id = c.req.param('id');
    if (!executor) return c.html(page('Error', html`<h1>Refunds need PayPal credentials</h1>`), 503);
    try {
      const payment = await executor.refund(id);
      const request = repo.getRequest(id);
      if (request) publishRequest('payment.refunded', request);
      return c.redirect(`/requests/${id}?notice=${encodeURIComponent(`Refunded (refund ${payment.paypalRefundId ?? '?'}).`)}`, 303);
    } catch (err) {
      return c.html(page('Error', html`<h1>Could not refund</h1><div class="error">${err instanceof Error ? err.message : String(err)}</div><p><a href="/requests/${id}">Back</a></p>`), 409);
    }
  });

  app.get('/audit', (c) => {
    const entries = repo.listAudit({ limit: 200 });
    return c.html(page('Audit log', html`<h1>Audit log</h1><p class="muted">Newest first, last 200 entries. Details hold ids and statuses only.</p><div class="card">${auditTable(entries)}</div>`));
  });

  // -------------------------------------------------------------- policy editor

  const policyForm = (agent: Agent, policy: Policy | undefined, error?: string, saved?: boolean) => {
    const p = policy;
    return html`<h1>Rules for ${agent.name}</h1>
${error ? html`<div class="error">${error}</div>` : ''}
${saved ? html`<div class="notice">Saved.</div>` : ''}
<form method="post" action="/policies/${agent.id}" class="card">
  <label>Currency</label><input name="currency" value="${p?.currency ?? 'USD'}" maxlength="3" required>
  <label>Max per purchase (held above this)</label><input name="max_tx" value="${p ? formatAmount(p.maxTxMinor) : '30.00'}" required>
  <label>Hard max per purchase (blocked above this; empty = none)</label><input name="hard_max_tx" value="${p?.hardMaxTxMinor === null || p?.hardMaxTxMinor === undefined ? '' : formatAmount(p.hardMaxTxMinor)}">
  <label>Monthly budget</label><input name="monthly_budget" value="${p ? formatAmount(p.monthlyBudgetMinor) : '100.00'}" required>
  <label>Merchant allowlist (comma-separated; empty = any merchant)</label><input name="merchants" value="${p?.merchantAllowlist?.join(', ') ?? ''}">
  <label>Category allowlist (comma-separated; empty = any category)</label><input name="categories" value="${p?.categoryAllowlist?.join(', ') ?? ''}">
  <label>Allowed hours, start and end (HH:MM; both empty = any time)</label>
  <div class="actions"><input name="hours_start" value="${p?.hours?.start ?? ''}" placeholder="08:00" style="width:120px"><input name="hours_end" value="${p?.hours?.end ?? ''}" placeholder="22:00" style="width:120px"></div>
  <label>Time zone (IANA)</label><input name="timezone" value="${p?.timezone ?? 'Asia/Tokyo'}" required>
  <label><input type="checkbox" name="hold_new" value="1" style="width:auto" ${p?.holdNewMerchants === false ? '' : 'checked'}> Hold the first purchase at a merchant this agent never paid before (only matters without an allowlist)</label>
  <p><button type="submit">Save rules</button> <a class="btn ghost" href="/">Cancel</a></p>
</form>`;
  };

  app.get('/policies/:agentId', (c) => {
    const agent = repo.getAgent(c.req.param('agentId'));
    if (!agent) return c.html(page('Not found', html`<h1>Unknown agent</h1>`), 404);
    return c.html(page('Rules', policyForm(agent, repo.getPolicy(agent.id), undefined, c.req.query('saved') === '1')));
  });

  app.post('/policies/:agentId', async (c) => {
    const agent = repo.getAgent(c.req.param('agentId'));
    if (!agent) return c.html(page('Not found', html`<h1>Unknown agent</h1>`), 404);
    const form = await c.req.parseBody();
    const field = (name: string): string => (typeof form[name] === 'string' ? (form[name] as string).trim() : '');
    const list = (name: string): string[] | null => {
      const items = field(name)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      return items.length === 0 ? null : items;
    };
    const maxTx = parseAmount(field('max_tx'));
    const hardRaw = field('hard_max_tx');
    const hardMax = hardRaw === '' ? null : parseAmount(hardRaw);
    const monthly = parseAmount(field('monthly_budget'));
    const start = field('hours_start');
    const end = field('hours_end');
    const problems: string[] = [];
    if (maxTx === undefined) problems.push('max per purchase must look like 30.00');
    if (hardRaw !== '' && hardMax === undefined) problems.push('hard max must look like 200.00 or be empty');
    if (monthly === undefined) problems.push('monthly budget must look like 100.00');
    if ((start === '') !== (end === '')) problems.push('give both hours or neither');
    const candidate: Omit<Policy, 'updatedAt'> = {
      agentId: agent.id,
      currency: field('currency').toUpperCase(),
      maxTxMinor: maxTx ?? 1,
      hardMaxTxMinor: hardMax ?? null,
      monthlyBudgetMinor: monthly ?? 1,
      merchantAllowlist: list('merchants'),
      categoryAllowlist: list('categories'),
      hours: start === '' ? null : { start, end },
      timezone: field('timezone'),
      holdNewMerchants: field('hold_new') === '1',
    };
    problems.push(...validatePolicy(candidate));
    if (problems.length > 0) return c.html(page('Rules', policyForm(agent, repo.getPolicy(agent.id), problems.join('; '))), 400);
    repo.savePolicy(candidate);
    repo.appendAudit({ actor: 'owner', action: 'policy.saved', agentId: agent.id, details: { source: 'dashboard' } });
    events.publish({ type: 'policy.saved', agentId: agent.id, at: now() });
    return c.redirect(`/policies/${agent.id}?saved=1`, 303);
  });

  // -------------------------------------------------------------- PayPal link flow

  const paypalPage = (notice?: string, error?: string) => {
    const mandate = repo.activeMandate();
    const mandates = repo.listMandates();
    return html`<h1>PayPal (sandbox)</h1>
${notice ? html`<div class="notice">${notice}</div>` : ''}
${error ? html`<div class="error">${error}</div>` : ''}
<div class="card">
${mandate ? html`<p>Linked. Active mandate <span class="mono">${mandate.id}</span> since ${when(mandate.createdAt)}. Agents never see it; the guard charges it only for approved requests.</p>` : html`<p>Not linked. Approve once with your <strong>sandbox personal</strong> account; after that the guard can charge approved requests with you absent.</p>`}
${paypal ? html`<form method="post" action="/paypal/link"><button type="submit">${mandate ? 'Link again (replaces the mandate)' : 'Link PayPal (sandbox)'}</button></form>` : html`<p class="muted">Linking needs PayPal sandbox credentials in .env.</p>`}
</div>
${mandates.length === 0 ? '' : html`<h2>Mandates</h2><div class="card"><table><thead><tr><th>Mandate</th><th>Status</th><th>Created</th></tr></thead><tbody>${mandates.map((m: Mandate) => html`<tr><td class="mono">${m.id}</td><td>${m.status}</td><td>${when(m.createdAt)}</td></tr>`)}</tbody></table></div>`}`;
  };

  app.get('/paypal', (c) => c.html(page('PayPal', paypalPage(c.req.query('notice'), c.req.query('error')))));

  app.post('/paypal/link', async (c) => {
    if (!paypal) return c.html(page('PayPal', paypalPage(undefined, 'Linking needs PayPal sandbox credentials in .env.')), 503);
    const key = randomBytes(8).toString('hex');
    try {
      const setup = await createSetupToken(paypal, {
        returnUrl: `${deps.publicBaseUrl}/paypal/return?link=${key}`,
        cancelUrl: `${deps.publicBaseUrl}/paypal/cancel?link=${key}`,
        key,
      });
      if (!setup.approveUrl) throw new Error('PayPal returned no approve link');
      pendingLinks.set(key, { setupTokenId: setup.id, createdAt: now() });
      repo.appendAudit({ actor: 'owner', action: 'mandate.link_started', details: { setupTokenId: setup.id } });
      return c.redirect(setup.approveUrl, 303);
    } catch (err) {
      return c.html(page('PayPal', paypalPage(undefined, `Could not start the link: ${err instanceof Error ? err.message : String(err)}`)), 502);
    }
  });

  app.get('/paypal/return', async (c) => {
    const key = c.req.query('link') ?? '';
    const pending = pendingLinks.get(key);
    if (!paypal || !pending) return c.redirect(`/paypal?error=${encodeURIComponent('Unknown or expired link attempt. Start again.')}`, 303);
    try {
      const status = await getSetupToken(paypal, pending.setupTokenId);
      if (status.status !== 'APPROVED') {
        return c.redirect(`/paypal?error=${encodeURIComponent(`The setup token is ${status.status}, not APPROVED. Approve it with the sandbox personal account, then try again.`)}`, 303);
      }
      const token = await createPaymentToken(paypal, pending.setupTokenId, key);
      const mandate = repo.saveMandate({ paypalVaultId: token.vaultId, paypalCustomerId: token.customerId });
      pendingLinks.delete(key);
      repo.appendAudit({ actor: 'owner', action: 'mandate.linked', details: { mandateId: mandate.id, setupTokenId: pending.setupTokenId } });
      events.publish({ type: 'mandate.linked', at: now() });
      return c.redirect(`/paypal?notice=${encodeURIComponent(`Linked. Mandate ${mandate.id} is active.`)}`, 303);
    } catch (err) {
      return c.redirect(`/paypal?error=${encodeURIComponent(`Could not finish the link: ${err instanceof Error ? err.message : String(err)}`)}`, 303);
    }
  });

  app.get('/paypal/cancel', (c) => {
    pendingLinks.delete(c.req.query('link') ?? '');
    return c.redirect(`/paypal?error=${encodeURIComponent('Linking was cancelled on the PayPal page.')}`, 303);
  });

  // -------------------------------------------------------------- SSE

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      // Subscribe before the first await, so a client that disconnects at once still gets unsubscribed.
      const unsubscribe = events.subscribe((e) => {
        void stream.writeSSE({ event: 'guard', data: JSON.stringify(e), id: String(id++) });
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ at: now() }), id: String(id++) });
      while (!stream.aborted) {
        await stream.sleep(deps.heartbeatMs ?? 15_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
    }),
  );

  // -------------------------------------------------------------- agent API (what the MCP server calls)

  app.post('/api/requests', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    const input = parsed.data;
    const amountMinor = toMinor(input.amount);
    if (amountMinor === undefined) return c.json({ error: 'invalid_request', issues: ['amount: must be a positive amount with two decimals, like 12.00'] }, 400);
    if (!repo.getAgent(input.agent_id)) return c.json({ error: 'unknown_agent', message: `No agent "${input.agent_id}" is registered with this guard.` }, 404);

    const result = await guard.submit({
      agentId: input.agent_id,
      merchant: input.merchant,
      item: input.item,
      category: input.category,
      amountMinor,
      currency: input.currency.toUpperCase(),
      reason: input.reason,
      sourceUrl: input.source_url ?? null,
    });
    publishRequest('request.decided', result.request);
    if (result.payment) publishRequest(result.payment.status === 'COMPLETED' ? 'payment.captured' : 'payment.failed', result.request);
    return c.json(requestView(repo, result.request), 201);
  });

  app.get('/api/requests/:id', (c) => {
    const request = repo.getRequest(c.req.param('id'));
    if (!request) return c.json({ error: 'unknown_request' }, 404);
    return c.json(requestView(repo, request));
  });

  app.get('/api/agents/:id/budget', (c) => {
    const agent = repo.getAgent(c.req.param('id'));
    if (!agent) return c.json({ error: 'unknown_agent' }, 404);
    return c.json(budgetView(repo, agent, now()));
  });

  app.get('/api/health', (c) => c.json({ ok: true, keyless: !executor, linked: repo.activeMandate() !== undefined }));

  return app;
}
