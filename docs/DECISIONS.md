# Decisions

Architecture decision log, oldest first. Each entry says what was decided, why, and what would change it.

## D1. Sandbox only, hard-coded (2026-10-27)

**Decision.** The only PayPal host the code can reach is `https://api-m.sandbox.paypal.com`. `PAYPAL_ENV` must be exactly `SANDBOX` or the process refuses to start, and the client re-checks every URL it is about to call (`assertSandboxUrl`).

**Why.** The hackathon requires a free, reproducible demo. Real money is out of scope and a liability. A hard guard is cheaper than reviewing every call site.

**Revisit.** Never, for this project.

## D2. How the guard moves money: Plan A (vault) first, Plan B (per-order approval) as fallback. PENDING the M0 spike

**Plan A.** Payment Method Tokens v3. The owner approves a setup token once with their PayPal (sandbox personal) account; the guard exchanges it for a payment token (`vault_id`) and charges policy-approved requests with Orders v2 `payment_source.paypal.vault_id`, buyer absent. Refunds via Payments v2.

**Plan B.** Every charge is an ordinary Orders v2 order with a payer-action link that the owner opens; the guard captures after approval.

**Risk.** The vault guide says: "You must be approved and have your account configured for billing agreements to set up a reference transaction." Whether a fresh sandbox app has this is only answerable by running `npm run spike:vault`.

**Design option kept open: hybrid.** AUTO_APPROVE charges the vault; HOLD sends the owner a PayPal approve link for that specific order, so PayPal's own checkout is the human-in-the-loop step. The product still works if vault is unavailable (then every charge is Plan B).

**Status.** Open. The decision and the spike output (statuses and ids only) will be recorded here after the owner runs both spike modes.

## D3. Who gets paid: the guard is a wallet operator, not a merchant (2026-10-27)

**Context.** Orders v2 with `vault_id` charges the owner's PayPal wallet and settles into the guard's own PayPal business account (the account that owns the sandbox app). The synthetic demo merchants never receive anything.

**Decision.** Frame the guard as a programmable spending account for agents: the owner links PayPal once, the guard charges that PayPal only when a request passes policy, and settlement with merchants happens off-screen (out of scope for the demo). Every order is stamped with `custom_id` (agent id and request id), `invoice_id` (unique per request, a second dedupe layer) and `description` (merchant and item), so the owner's PayPal activity reads like the audit log.

**Why.** It is honest, and it makes PayPal visibly central. The alternative (routing payment to other merchant accounts via `payee`) needs PayPal partner onboarding that judges cannot reproduce.

**To confirm in the spike.** Whether the sandbox rejects duplicate `invoice_id` values by default, and the maximum lengths of `custom_id` and `description` (the documentation index pages gave no field-level detail).

## D4. LLM: mock by default, Anthropic as the first real provider, model chosen at M3 (2026-10-27)

**Decision.** `LLM_PROVIDER=mock` is the default and must always work without a key (deterministic reviewer and shopping agent). The first real provider wired through the Vercel AI SDK will be Anthropic; the model id is chosen at M3 against current documentation, not now.

**Why.** Judges must be able to run everything for free, and mock mode makes tests deterministic. The AI reviewer may only tighten a decision (allow to hold or block), never loosen it, and any LLM failure or timeout means HOLD, so the mock/real choice never changes safety.

## D5. Runtime: Node 22.13 or newer; SQLite through the built-in `node:sqlite` (2026-10-27)

**Decision.** `engines.node >= 22.13`. Node 20 reached end of life in April 2026 and current Vitest requires 22 or newer. The database is Node's built-in `node:sqlite` (`DatabaseSync`), not `better-sqlite3`.

**Why.** No native module to build or prebuild: `npm ci` stays dependency-free for judges on any platform. The synchronous API covers everything the guard needs (prepared statements, transactions, WAL). Verified on Node 24.16 with SQLite 3.53, including a database file under a path with non-ASCII characters (tested).

**Caveat.** Node 22.x prints an `ExperimentalWarning` for `node:sqlite`; it is harmless and goes away on Node 23.4+ and 24. Booleans are stored as 0/1 and timestamps as integer epoch milliseconds because the driver binds only null, numbers, bigints, strings and buffers.

## D6. No dotenv: Node's `process.loadEnvFile` (2026-10-27)

`.env` is loaded with Node's built-in parser. Tooling and the coding assistant never read, print or commit `.env`; `npm run check-env` reports each key only as set or missing.

## D7. Secret hygiene for a repository that will go public (2026-10-27)

The pre-commit hook (`.githooks/pre-commit`, enabled by `npm install` through the `prepare` script) refuses `.env*`, `.spike-state.json` and database files outright, runs gitleaks on staged changes when it is installed, and warns loudly when it is not. CI runs gitleaks over the full history on every push; that is the enforced layer. The repository stays private until the owner flips it.

## D8. Idempotency: `PayPal-Request-Id` derived from our own ids (2026-10-27)

`requestIdFor(scope, key)` yields `asg-<scope>-<first 32 hex chars of sha256(scope, key)>`. Creating an order, capturing it and refunding it for the same request each get a stable id, so a retried call cannot double-charge. `invoice_id` is also set per request (D3).

## D9. Policy verdicts: HOLD means "ask the owner", BLOCK means "do not even ask" (2026-10-27)

**Decision.** The deterministic engine (`src/policy/engine.ts`) returns `ALLOW`, `HOLD` or `BLOCK` plus every triggered reason code. Each code has a fixed severity (`src/policy/reasons.ts`):

- `HOLD` (the request is outside the owner's rules; the owner decides on their phone): `OVER_TX_CAP`, `OVER_MONTHLY_BUDGET`, `MERCHANT_NOT_ALLOWED`, `CATEGORY_NOT_ALLOWED`, `OUTSIDE_TIME_WINDOW`, `NEW_MERCHANT`.
- `BLOCK` (nothing to decide): `AGENT_DISABLED`, `NO_POLICY`, `INVALID_AMOUNT`, `CURRENCY_MISMATCH`, `OVER_HARD_TX_CAP` (an optional ceiling the owner never wants to be asked about).

The verdict is the worst severity present. Caps and the budget are inclusive (equal is fine, one cent over is not). The hours window is `[start, end)` in the policy zone, wraps past midnight when `start > end`, and `start == end` means the whole day. A misconfigured hours window fails closed (HOLD). Allowlist matching is case-, width- and whitespace-insensitive (NFKC). An allowlisted merchant counts as known; `NEW_MERCHANT` only fires when the policy has no merchant allowlist.

**Composition with later steps.** Verdicts map onto the final decision vocabulary as `ALLOW -> AUTO_APPROVE`, `HOLD -> HOLD`, `BLOCK -> BLOCK`. The AI reviewer (M3) may only move a decision to the right (`AUTO_APPROVE -> HOLD -> BLOCK`), never to the left, and any reviewer failure or timeout means `HOLD`. Suspicion (prompt injection, reason/item mismatch, price anomaly) therefore comes from the reviewer; the engine blocks only on hard facts.

**Why.** Judges and owners should be able to predict the engine. Putting the "ask a human" line at the rules and the "never" line at hard facts keeps the owner in control without making them approve nonsense.

## D10. Budget accounting and the request lifecycle (2026-10-27)

**Spend that counts** against an agent's monthly budget (`Repo.spentThisMonthMinor`): completed PayPal captures whose `captured_at` falls in the policy's calendar month (in the policy's IANA zone), plus requests in `AUTO_APPROVED` or `APPROVED` that are not yet captured (in flight, usually for seconds). `HELD` requests reserve nothing; an owner approving a held request may knowingly exceed the budget. Refunded captures no longer count, so a refund gives the budget back. Failed payments never count.

**Request statuses.** `EVALUATING -> AUTO_APPROVED | HELD | BLOCKED`; `HELD -> APPROVED | DENIED` (owner); `AUTO_APPROVED | APPROVED -> PAID | PAYMENT_FAILED`; `PAID -> REFUNDED`. The status transition and the matching payment update must happen in one transaction (`Repo.transaction`) so a request is never counted twice as in-flight and captured.

**Month boundaries** come from `Intl.DateTimeFormat` with two offset passes (`src/policy/time.ts`), tested across a DST change (America/New_York, March and November 2026) and a half-hour zone (Asia/Kolkata). The demo policy uses Asia/Tokyo.
