/**
 * The guard server: owner dashboard (server-rendered HTML, a little JS), the JSON API agents use through the MCP
 * server, and an SSE stream that refreshes open dashboards. Every request field (merchant, item, reason, URL) is
 * untrusted text and is only ever interpolated through hono/html, which escapes it.
 */
import { randomBytes } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { html, raw } from 'hono/html';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Repo } from '../db/repo.js';
import { formatAmount, parseAmount } from '../domain/money.js';
import type { Agent, AuditEntry, Decision, Mandate, Payment, Policy, PurchaseRequest, RequestStatus } from '../domain/types.js';
import type { PayPalExecutor } from '../guard/executor.js';
import type { Guard } from '../guard/pipeline.js';
import type { PayPalClient } from '../paypal/client.js';
import { describePayPalError } from '../paypal/errors.js';
import { mask } from '../paypal/redact.js';
import { createPaymentToken, createSetupToken, getSetupToken } from '../paypal/vault.js';
import { monthBounds } from '../policy/time.js';
import { validatePolicy } from '../policy/validate.js';
import { FLAG_RISK, FLAG_TEXT, type ReviewFlag } from '../review/flags.js';
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
  /** Which AI reviewer is active, shown on the dashboard so mock mode is never mistaken for a model. */
  reviewer?: { label: string; mock: boolean };
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
  if (typeof amount === 'number') {
    // A number is taken only when it is exact to the cent: 12.005 is refused, as the string "12.005" is, never rounded (D16).
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    const cents = amount * 100;
    if (Math.abs(cents - Math.round(cents)) > 1e-6) return undefined;
    return parseAmount(amount.toFixed(2));
  }
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

const bareHost = (hostname: string): string => hostname.replace(/^\[|\]$/g, '').toLowerCase();

/**
 * Hosts the guard answers to: loopback names on any port, plus the host the owner configured as PUBLIC_BASE_URL (the
 * LAN address when the dashboard is shown on a phone). Any other Host header is a DNS-rebinding attempt or a misrouted
 * proxy and is refused before any route runs (D16).
 */
export function hostAllowed(requestUrl: string, publicBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  const hostname = bareHost(url.hostname);
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  try {
    const configured = new URL(publicBaseUrl);
    return url.host.toLowerCase() === configured.host.toLowerCase() || hostname === bareHost(configured.hostname);
  } catch {
    return false;
  }
}

/** The event a finished charge publishes: CREATED means PayPal never confirmed the outcome (D16). */
const paymentEvent = (payment: Payment): string => (payment.status === 'COMPLETED' ? 'payment.captured' : payment.status === 'CREATED' ? 'payment.unsettled' : 'payment.failed');

/** An approved request whose charge stopped without PayPal's answer: payment row still CREATED. */
const isUnsettled = (request: PurchaseRequest, payment: Payment | undefined): boolean =>
  payment?.status === 'CREATED' && (request.status === 'AUTO_APPROVED' || request.status === 'APPROVED');

// ------------------------------------------------------------------ view models

const MESSAGES: Record<RequestStatus, string> = {
  EVALUATING: 'Being evaluated.',
  AUTO_APPROVED: 'Approved by policy; the charge is in progress.',
  HELD: 'Held for the owner. Poll get_request_status for their decision; do not retry the purchase.',
  BLOCKED: 'Blocked. Do not retry.',
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
  const review = decision && (decision.reviewRisk !== null || decision.reviewFlags.length > 0) ? { risk: decision.reviewRisk, flags: decision.reviewFlags, explanation: decision.reviewExplanation } : null;
  // Agents learn why they were held or blocked (flags and the reviewer's sentence), nothing about the owner's PayPal side.
  // A low-risk review of a request the rules held adds nothing, so it stays out of the message.
  const reviewMessage =
    review && (request.status === 'HELD' || request.status === 'BLOCKED') && (review.flags.length > 0 || (review.risk !== null && review.risk !== 'low'))
      ? `${review.flags.length > 0 ? ` AI review flags: ${review.flags.join(', ')}.` : ''}${review.explanation ? ` ${review.explanation}` : ''}`
      : '';
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
          review,
          decided_by: decision.decidedBy,
        }
      : null,
    payment: payment ? { status: payment.status, paypal_order_id: payment.paypalOrderId, paypal_capture_id: payment.paypalCaptureId, paypal_refund_id: payment.paypalRefundId } : null,
    message: `${MESSAGES[request.status]}${isUnsettled(request, payment) ? ' PayPal has not confirmed the charge yet; the owner will settle it. Do not retry the purchase.' : ''}${reasons.length > 0 ? ` Reasons: ${reasons.map((r) => r.message).join('; ')}.` : ''}${reviewMessage}`,
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
  .review { background: #f5f3ff; border-left: 3px solid #7c3aed; padding: 6px 10px; margin: 6px 0; font-size: 14px; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 6px; font-size: 11px; font-weight: 600; background: #f1f5f9; color: #334155; border: 1px solid #e2e8f0; margin: 2px 4px 0 0; white-space: nowrap; }
  .chip.bad { background: #fee2e2; color: #991b1b; border-color: #fecaca; } .chip.hold { background: #fef3c7; color: #92400e; border-color: #fde68a; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f8fafc; padding: 8px; border-radius: 6px; font-size: 12px; }
  .mono { font-family: ui-monospace, monospace; font-size: 13px; }
  .wrap { word-break: break-word; }
  @media (max-width: 600px) {
    th:nth-child(n+5), td:nth-child(n+5), .requests th:first-child, .requests td:first-child { display: none; }
    table { display: block; max-width: 100%; overflow-x: auto; }
    .chip { font-size: 10px; padding: 1px 5px; }
    main { padding: 10px; } h1 { font-size: 20px; } .card { padding: 12px; }
    header { gap: 10px; padding: 10px 12px; } header a { font-size: 14px; }
    button, .btn { min-height: 44px; padding: 10px 14px; }
    .actions.decide { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .actions.decide form, .actions.decide .btn { width: 100%; } .actions.decide form button { width: 100%; } .actions.decide .btn { grid-column: 1 / -1; text-align: center; }
    input, select { font-size: 16px; }
    .mono { font-size: 12px; }
  }
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

const RISK_CLASS: Record<string, string> = { low: 'ok', medium: 'hold', high: 'bad' };
const riskBadge = (risk: string): Html => html`<span class="badge ${RISK_CLASS[risk] ?? ''}">risk ${risk}</span>`;

/** One chip per reviewer flag, coloured by what the flag does and explained on hover. */
function flagChips(flags: readonly string[]): Html {
  return html`${flags.map((f) => {
    const known = (FLAG_RISK as Record<string, unknown>)[f] !== undefined;
    const floor = known ? FLAG_RISK[f as ReviewFlag] : null;
    const cls = floor === 'high' ? 'bad' : floor === 'medium' ? 'hold' : '';
    return html`<span class="chip ${cls}" title="${known ? FLAG_TEXT[f as ReviewFlag] : ''}">${f}</span>`;
  })}`;
}

/** The reviewer's verdict. Compact (queue cards): a low-risk review with no flags is one quiet line, the detail page has the rest. */
function reviewBlock(decision: Decision, opts: { compact?: boolean } = {}): Html {
  if (decision.reviewRisk === null && decision.reviewFlags.length === 0) return html``;
  if (opts.compact && decision.reviewRisk === 'low' && decision.reviewFlags.length === 0) return html`<div class="muted">AI review: risk low, no flags.</div>`;
  return html`<div class="review"><strong>AI review</strong> ${decision.reviewRisk === null ? '' : riskBadge(decision.reviewRisk)} ${flagChips(decision.reviewFlags)}
  ${decision.reviewExplanation ? html`<div class="wrap" style="margin-top:4px">${decision.reviewExplanation}</div>` : ''}</div>`;
}

interface RequestRowData {
  request: PurchaseRequest;
  flags: readonly string[];
}

function requestRow({ request: r, flags }: RequestRowData): Html {
  return html`<tr>
  <td><a href="/requests/${r.id}" class="mono">${r.id}</a></td>
  <td>${badge(r.status)}${flags.length > 0 ? html`<div>${flagChips(flags)}</div>` : ''}</td>
  <td class="wrap"><a href="/requests/${r.id}">${r.merchant}</a><div class="muted">${r.item}</div></td>
  <td>${money(r.amountMinor, r.currency)}</td>
  <td>${r.agentId}</td>
  <td class="muted">${when(r.createdAt)}</td>
</tr>`;
}

function requestTable(rows: RequestRowData[], empty: string): Html {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<table class="requests">
<thead><tr><th>Request</th><th>Status</th><th>Merchant / item</th><th>Amount</th><th>Agent</th><th>Created</th></tr></thead>
<tbody>${rows.map(requestRow)}</tbody>
</table>`;
}

function decisionBlock(decision: Decision | undefined): Html {
  if (!decision) return html`<p class="muted">No decision yet.</p>`;
  return html`<p>Policy said <strong>${decision.policyVerdict}</strong>; final decision <strong>${decision.finalDecision}</strong> (by ${decision.decidedBy}).</p>
${decision.policyReasons.map((r) => html`<div class="reason"><strong>${r.code}</strong> ${r.message}</div>`)}
${reviewBlock(decision)}`;
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
  const app = new Hono();

  // Link attempts in progress, keyed by the random value in PayPal's return URL. A setup token is approved within
  // minutes or not at all, so attempts expire, and only a few may be open at once (each one cost a PayPal call) (D16).
  const pendingLinks = new Map<string, { setupTokenId: string; createdAt: number }>();
  const LINK_TTL_MS = 15 * 60_000;
  const LINK_MAX_PENDING = 20;
  const pruneLinks = (): void => {
    const cutoff = now() - LINK_TTL_MS;
    for (const [key, pending] of pendingLinks) if (pending.createdAt < cutoff) pendingLinks.delete(key);
    while (pendingLinks.size > LINK_MAX_PENDING) {
      const oldest = pendingLinks.keys().next().value; // insertion order
      if (oldest === undefined) break;
      pendingLinks.delete(oldest);
    }
  };

  // One owner action per request at a time: a double click or two tabs cannot race two charges or two refunds (D16).
  const busy = new Set<string>();
  const withLock = async <T>(id: string, work: () => Promise<T>): Promise<T | undefined> => {
    if (busy.has(id)) return undefined;
    busy.add(id);
    try {
      return await work();
    } finally {
      busy.delete(id);
    }
  };
  const inProgress = (c: Context, id: string) => c.html(page('Busy', html`<h1>Another action on this request is still running</h1><p><a href="/requests/${id}">Back</a></p>`), 409);

  // Order matters (D16): the Host check runs before any route (DNS rebinding of a loopback server); hono/csrf then
  // refuses a POST with a form content type unless its Origin or Sec-Fetch-Site says same-origin (JSON from the MCP
  // server is not a form type and needs no Origin); every response leaves with headers that keep the dashboard out of
  // frames on other sites and stop content sniffing.
  app.use('*', async (c, next) => {
    if (!hostAllowed(c.req.url, deps.publicBaseUrl)) return c.text('Unexpected Host header: the guard answers on localhost and on PUBLIC_BASE_URL only.', 400);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('X-Frame-Options', 'DENY');
  });
  app.use('*', csrf());

  const publishRequest = (type: string, request: PurchaseRequest): void => {
    events.publish({ type, requestId: request.id, agentId: request.agentId, status: request.status, at: now() });
  };

  // -------------------------------------------------------------- dashboard

  app.get('/', (c) => {
    const nowMs = now();
    const agents = repo.listAgents();
    const held = repo.listRequests({ status: 'HELD', limit: 50 });
    const unsettled = repo.unsettledRequests();
    const recent = repo.listRequests({ limit: 20 });
    const mandate = repo.activeMandate();
    const body = html`<h1>Overview</h1>
${executor ? '' : html`<div class="notice">Keyless mode: requests are decided but nothing is charged (no PayPal sandbox credentials in .env).</div>`}
${mandate ? '' : html`<div class="error">PayPal is not linked yet: approved requests cannot be charged. <a href="/paypal">Link PayPal (sandbox)</a></div>`}
${deps.reviewer ? html`<div class="notice">AI reviewer: <strong>${deps.reviewer.label}</strong>${deps.reviewer.mock ? ' — set LLM_PROVIDER=anthropic and LLM_API_KEY in .env for a real model.' : ''} It can only tighten decisions; a failure means HOLD.</div>` : ''}
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
${unsettled.length === 0 ? '' : html`<h2>Payments to settle (${unsettled.length})</h2>
${unsettled.map((r) => html`<div class="card">
  <div class="actions"><strong>${money(r.amountMinor, r.currency)}</strong> at <strong class="wrap">${r.merchant}</strong> <span class="muted">by ${r.agentId}</span> ${badge(r.status)}</div>
  <div class="muted">PayPal did not confirm this charge. The amount still counts against the budget. <a href="/requests/${r.id}">Open and retry</a></div>
</div>`)}`}
<h2>Waiting for you (${held.length})</h2>
${held.length === 0 ? html`<p class="muted">Nothing is waiting.</p>` : ''}
${held.map((r) => {
  const decision = repo.latestDecision(r.id);
  return html`<div class="card">
  <div class="actions"><strong>${money(r.amountMinor, r.currency)}</strong> at <strong class="wrap">${r.merchant}</strong> <span class="muted">by ${r.agentId}</span> ${badge(r.status)}</div>
  <div class="wrap">${r.item}</div>
  <div class="muted wrap">Agent's reason: “${r.reason}”</div>
  ${(decision?.policyReasons ?? []).map((reason) => html`<div class="reason"><strong>${reason.code}</strong> ${reason.message}</div>`)}
  ${decision ? reviewBlock(decision, { compact: true }) : ''}
  <div class="actions decide" style="margin-top:8px">
    <form method="post" action="/requests/${r.id}/approve"><button type="submit">Approve &amp; pay</button></form>
    <form method="post" action="/requests/${r.id}/deny"><button type="submit" class="deny">Deny</button></form>
    <a class="btn ghost" href="/requests/${r.id}">Details</a>
  </div>
</div>`;
})}
<h2>Recent requests</h2>
${requestTable(
  recent.map((request) => ({ request, flags: repo.latestDecision(request.id)?.reviewFlags ?? [] })),
  'No requests yet. Run the demo agent.',
)}`;
    return c.html(page('Overview', body));
  });

  app.get('/requests/:id', (c) => {
    const request = repo.getRequest(c.req.param('id'));
    if (!request) return c.html(page('Not found', html`<h1>Unknown request</h1>`), 404);
    const decision = repo.latestDecision(request.id);
    const payment = repo.paymentForRequest(request.id);
    const newestFirst = repo.listAudit({ requestId: request.id });
    const audit = [...newestFirst].reverse();
    const url = safeUrl(request.sourceUrl);
    const notice = c.req.query('notice');
    const unsettled = isUnsettled(request, payment);
    const unsettledReason = unsettled ? newestFirst.find((a) => a.action === 'payment.unsettled')?.details['reason'] : undefined;
    const body = html`<h1>Request <span class="mono">${request.id}</span> ${badge(request.status)}</h1>
${notice ? html`<div class="notice">${notice}</div>` : ''}
${unsettled ? html`<div class="error"><strong>Payment outcome unknown.</strong> ${typeof unsettledReason === 'string' ? html`${unsettledReason}. ` : ''}PayPal may or may not have charged this; the amount stays counted against the budget until it is settled. Retrying looks the order up first and cannot charge twice.</div>` : ''}
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
<div class="actions decide">
${request.status === 'HELD' ? html`<form method="post" action="/requests/${request.id}/approve"><button type="submit">Approve &amp; pay</button></form><form method="post" action="/requests/${request.id}/deny"><input type="hidden" name="note" value=""><button type="submit" class="deny">Deny</button></form>` : ''}
${request.status === 'PAID' && executor ? html`<form method="post" action="/requests/${request.id}/refund"><button type="submit" class="ghost">Refund</button></form>` : ''}
${unsettled && executor ? html`<form method="post" action="/requests/${request.id}/charge"><button type="submit">Retry payment</button></form>` : ''}
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
      const outcome = await withLock(id, () => guard.approve(id, 'owner'));
      if (!outcome) return inProgress(c, id);
      const { request, payment } = outcome;
      publishRequest('owner.approved', request);
      if (payment) publishRequest(paymentEvent(payment), request);
      const notice = !payment
        ? 'Approved. Nothing was charged (keyless mode).'
        : payment.status === 'COMPLETED'
          ? `Approved and paid (capture ${payment.paypalCaptureId ?? '?'}).`
          : payment.status === 'CREATED'
            ? 'Approved, but PayPal did not confirm the charge. Retry it from the payment section below.'
            : 'Approved, but the payment failed.';
      return c.redirect(`/requests/${id}?notice=${encodeURIComponent(notice)}`, 303);
    } catch (err) {
      return c.html(page('Error', html`<h1>Could not approve</h1><div class="error">${err instanceof Error ? err.message : String(err)}</div><p><a href="/requests/${id}">Back</a></p>`), 409);
    }
  });

  app.post('/requests/:id/charge', async (c) => {
    const id = c.req.param('id');
    if (!executor) return c.html(page('Error', html`<h1>Retrying a payment needs PayPal credentials</h1>`), 503);
    try {
      const payment = await withLock(id, () => guard.retryCharge(id, 'owner'));
      if (!payment) return inProgress(c, id);
      const request = repo.getRequest(id);
      if (request) publishRequest(paymentEvent(payment), request);
      const notice =
        payment.status === 'COMPLETED'
          ? `Paid (capture ${payment.paypalCaptureId ?? '?'}).`
          : payment.status === 'FAILED'
            ? 'PayPal refused the charge; nothing was paid and the budget is free again.'
            : 'Still unsettled: PayPal did not confirm the outcome. Try again in a moment.';
      return c.redirect(`/requests/${id}?notice=${encodeURIComponent(notice)}`, 303);
    } catch (err) {
      return c.html(page('Error', html`<h1>Could not retry the payment</h1><div class="error">${err instanceof Error ? err.message : String(err)}</div><p><a href="/requests/${id}">Back</a></p>`), 409);
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
      const payment = await withLock(id, () => executor.refund(id));
      if (!payment) return inProgress(c, id);
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
      pruneLinks();
      const setup = await createSetupToken(paypal, {
        returnUrl: `${deps.publicBaseUrl}/paypal/return?link=${key}`,
        cancelUrl: `${deps.publicBaseUrl}/paypal/cancel?link=${key}`,
        key,
      });
      if (!setup.approveUrl) throw new Error('PayPal returned no approve link');
      pendingLinks.set(key, { setupTokenId: setup.id, createdAt: now() });
      pruneLinks();
      // The audit log is readable on the login-less dashboard: the setup token id goes in masked, like every PayPal
      // authorization artefact; the unmasked id lives only in pendingLinks until the attempt ends.
      repo.appendAudit({ actor: 'owner', action: 'mandate.link_started', details: { setupTokenId: mask(setup.id) } });
      return c.redirect(setup.approveUrl, 303);
    } catch (err) {
      // describePayPalError: status, error name, issue codes and debug id, redacted; never PayPal's response body.
      return c.html(page('PayPal', paypalPage(undefined, `Could not start the link: ${describePayPalError(err, paypal)}`)), 502);
    }
  });

  app.get('/paypal/return', async (c) => {
    const key = c.req.query('link') ?? '';
    pruneLinks();
    const pending = pendingLinks.get(key);
    if (!paypal || !pending) return c.redirect(`/paypal?error=${encodeURIComponent('Unknown or expired link attempt. Start again.')}`, 303);
    // One try per attempt: approved or not, failed or not, the attempt is over and the owner starts again.
    pendingLinks.delete(key);
    try {
      const status = await getSetupToken(paypal, pending.setupTokenId);
      if (status.status !== 'APPROVED') {
        return c.redirect(`/paypal?error=${encodeURIComponent(`The setup token is ${status.status}, not APPROVED. Approve it with the sandbox personal account, then start again.`)}`, 303);
      }
      const token = await createPaymentToken(paypal, pending.setupTokenId, key);
      const mandate = repo.saveMandate({ paypalVaultId: token.vaultId, paypalCustomerId: token.customerId });
      repo.appendAudit({ actor: 'owner', action: 'mandate.linked', details: { mandateId: mandate.id, setupTokenId: mask(pending.setupTokenId) } });
      events.publish({ type: 'mandate.linked', at: now() });
      return c.redirect(`/paypal?notice=${encodeURIComponent(`Linked. Mandate ${mandate.id} is active.`)}`, 303);
    } catch (err) {
      return c.redirect(`/paypal?error=${encodeURIComponent(`Could not finish the link: ${describePayPalError(err, paypal)}`)}`, 303);
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
    // JSON only. A browser can send text/plain cross-site without a preflight; application/json it cannot (D16).
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) return c.json({ error: 'unsupported_media_type', message: 'Send the request as application/json.' }, 415);
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
    if (result.payment) publishRequest(paymentEvent(result.payment), result.request);
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
