# Decisions

Architecture decision log, oldest first. Each entry says what was decided, why, and what would change it.

## D1. Sandbox only, hard-coded (2026-10-27)

**Decision.** The only PayPal host the code can reach is `https://api-m.sandbox.paypal.com`. `PAYPAL_ENV` must be exactly `SANDBOX` or the process refuses to start, and the client re-checks every URL it is about to call (`assertSandboxUrl`).

**Why.** The hackathon requires a free, reproducible demo. Real money is out of scope and a liability. A hard guard is cheaper than reviewing every call site.

**Revisit.** Never, for this project.

## D2. How the guard moves money: Plan A (vault), decided by the M0 spike (2026-10-28)

**Plan A.** Payment Method Tokens v3. The owner approves a setup token once with their PayPal (sandbox personal) account; the guard exchanges it for a payment token (`vault_id`) and charges policy-approved requests with Orders v2 `payment_source.paypal.vault_id`, buyer absent. Refunds via Payments v2.

**Plan B.** Every charge is an ordinary Orders v2 order with a payer-action link that the owner opens; the guard captures after approval.

**Risk that did not materialise.** The vault guide says: "You must be approved and have your account configured for billing agreements to set up a reference transaction." A fresh sandbox REST app with *Accept payments* and *Vault* ticked needed no further approval.

**Spike result, Plan A (`npm run spike:vault`, run 20261028044428, 1.00 USD, US personal buyer).** Statuses and ids only; the vault id itself lives in the gitignored `.spike-state.json`.

| step | result |
| --- | --- |
| `POST /v3/vault/setup-tokens` | 201, `PAYER_ACTION_REQUIRED`, id `56H4…` (masked) |
| owner approval | browser redirect to `127.0.0.1:8787/return`; token `APPROVED` |
| `POST /v3/vault/payment-tokens` | 201, payment token created (masked `9uc...3j`) |
| `POST /v2/checkout/orders` with `vault_id`, buyer absent | 201, order `55M30185U89391303` returned **`COMPLETED` on create**, capture `7YX66140XX426782L` (no separate capture call) |
| `POST /v2/payments/captures/{id}/refund` | 201, refund `3VT19252072297030` `COMPLETED` |

A first run the same day timed out after 10 minutes because the approval page was not opened in time; nothing was charged and the unused setup token simply expired.

**Spike result, Plan B (`npm run spike:order`, run 20261028044826, 1.00 USD, same buyer).** `POST /v2/checkout/orders` with `experience_context` and `user_action: PAY_NOW` returned `PAYER_ACTION_REQUIRED`, order `04L9549118260180V`; after the owner approved in PayPal checkout (redirect caught the same way) the order read `APPROVED`, `POST .../capture` gave capture `7UB02637BE104741F` `COMPLETED`, and the refund `1HH20177WF753424B` completed. So both paths work on this app.

**Decision.** The executor charges with `vault_id`. The owner links PayPal once (a *mandate*, stored in the `mandates` table), and both `AUTO_APPROVE` and an owner-approved `HOLD` are charged through that mandate; the human-in-the-loop step is the guard's own dashboard, not PayPal's checkout page. Plan B stays as the documented fallback for an account without vault, and the `spike:order` mode stays in the repo to prove it.

**Consequences for the executor.** Handle both shapes of the create-order response: `COMPLETED` on create (what the sandbox did here) and `APPROVED`/`CREATED` that needs an explicit capture. Give the approval wait in the dashboard's "link PayPal" step a generous timeout. Keep every order stamped as D3 says.

**Still unconfirmed by the spike.** Duplicate `invoice_id` behaviour and the maximum lengths of `custom_id` and `description` (both runs used unique ids and short strings).

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

**Spend that counts** against an agent's monthly budget (`Repo.spentThisMonthMinor`): completed PayPal captures whose `captured_at` falls in the policy's calendar month (in the policy's IANA zone), plus requests in `AUTO_APPROVED` or `APPROVED` that are not yet captured (in flight, usually for seconds). `HELD` requests reserve nothing; an owner approving a held request may knowingly exceed the budget. Refunded captures no longer count, so a refund gives the budget back. Failed payments never count. Since D16, while a request is being decided, the agent's older requests that are still `EVALUATING` count too, first come first served; a request never counts against itself, and a payment PayPal never confirmed stays in flight until the owner's retry settles it.

**Request statuses.** `EVALUATING -> AUTO_APPROVED | HELD | BLOCKED`; `HELD -> APPROVED | DENIED` (owner); `AUTO_APPROVED | APPROVED -> PAID | PAYMENT_FAILED`; `PAID -> REFUNDED`. The status transition and the matching payment update must happen in one transaction (`Repo.transaction`) so a request is never counted twice as in-flight and captured.

**Month boundaries** come from `Intl.DateTimeFormat` with two offset passes (`src/policy/time.ts`), tested across a DST change (America/New_York, March and November 2026) and a half-hour zone (Asia/Kolkata). The demo policy uses Asia/Tokyo.

## D11. The executor: how a decision becomes a PayPal charge (2026-10-28)

**Shape.** `src/guard/pipeline.ts` turns a request into a decision (policy engine, then the reviewer hook that may only tighten, then one transaction that writes the decision row, the request status and an audit entry). `src/guard/executor.ts` charges `AUTO_APPROVED` and `APPROVED` requests through the single active mandate (`Repo.activeMandate`) with Orders v2 and `payment_source.paypal.vault_id`, and refunds captures with Payments v2.

**Rules.**

- PayPal is never called inside a database transaction (`node:sqlite` is synchronous and transactions do not nest). The sequence is: open the payment row (`Repo.beginPayment`), call PayPal, then settle or fail in one transaction (`settlePayment`, `failPayment`, `refundPayment`), so a request is never counted both as in flight and as captured (D10).
- PayPal-side failures are recorded, not thrown: the payment ends `FAILED`, the request `PAYMENT_FAILED`, and the audit entry carries the redacted PayPal error name, issues and debug id. Only programming errors (charging a request that is not approved) throw.
- Three order shapes are handled: `COMPLETED` on create (what the sandbox does for vault charges), `APPROVED`/`CREATED` followed by an explicit capture, and anything else (such as `PAYER_ACTION_REQUIRED`) as a failure. A capture whose status is not `COMPLETED` is a failure that keeps the capture id.
- Idempotency keys come from the request id (D8): `order:<requestId>`, `capture:<requestId>:<orderId>`, `refund:<requestId>:<captureId>`, and `invoice_id` is `ASG-<requestId>`, so a replay repeats every identifier. After a crash, an order id already recorded is looked up with GET instead of re-created; a payment row without an order id is simply retried under the same keys, and `payment.started` is audited only once per request.
- A refund that PayPal reports as `PENDING` is treated like `COMPLETED`: the request becomes `REFUNDED` and the budget comes back at once. Good enough for the demo; a webhook-driven settlement would be the production answer.
- The vault id is registered with the client's redactor before the first call and never written to audit details or logs; audit entries reference the mandate by its own id. Tests assert that the vault id appears nowhere visible.
- The owner links PayPal once. In M1 `npm run link-paypal -- --from-spike-state` imports the token the spike saved; the interactive link flow (setup token, approval, payment token) arrives with the dashboard in M2.

**Proof (`npm run e2e:sandbox`, 2026-10-28, 1.00 USD).** Request `req_90d279a61e01` on the synthetic demo agent: policy `ALLOW`, decision `AUTO_APPROVE` by policy, order `61P47474677513627` `COMPLETED` on create with capture `1FP43248JA310423N`, request `PAID`; refund `08S23452YU932140Y` `COMPLETED`, request `REFUNDED`, budget back to 0.00. Three PayPal calls in all (token, order, refund). The stamped `custom_id` (`asg:demo-agent:req_…`), `invoice_id` (`ASG-req_…`) and description were accepted.

**Still unconfirmed.** PayPal's behaviour on a duplicate `invoice_id` and the exact field limits (the guard clamps at 127 characters; no 127-character field has been sent yet).

## D12. M2 topology: one guard process, a credential-free MCP server, the shop on its own origin (2026-10-28)

**Decision.** `npm run dev` starts one guard process (Hono on Node) that owns the database, the PayPal client and an in-process event bus, and serves three things: the owner dashboard (server-rendered HTML with a few lines of JS that reload the page on server-sent events), the JSON API agents use, and the SSE stream. The synthetic shop is served by the same process but on a second port, so untrusted product pages and the forms that approve charges never share an origin; shop pages carry `default-src 'none'` and contain no script.

The MCP server (`src/mcp`) is a stdio process that holds nothing: it does not load `.env`, and each tool is one call to the guard's API, so an agent host (Claude Desktop, the demo agent) never shares a process with PayPal credentials or the vault id. Tool results are statuses, ids and a plain-language message.

**Why not Vite + React, AG Grid, Express.** No build step and no front-end toolchain for judges to run; `hono/html` escapes every interpolation, which matters because merchant, item and reason are attacker-controlled text (tested with script, event-handler and `javascript:` payloads). The audit table is plain HTML for now (M3 may revisit AG Grid Community).

**The mock agent obeys the page on purpose.** In mock mode the shopping agent extracts all text from a product page, hidden text included, and follows "buy N units / use the reason …" instructions. That is the demo's point: the agent is not the safety layer. M2 ends the injected request in `HELD` (`OVER_TX_CAP`, `MERCHANT_NOT_ALLOWED`); the M3 reviewer turns it into `BLOCK`.

**Observed on the sandbox (2026-10-28).** Scenario 1 paid 12.00 USD through MCP → API → policy → executor (order `5FH55065K4253130A`, capture `9BM1973965522664L`); scenario 2 was held, approved on the dashboard and paid (order `0WB26883WG213635W`, capture `7AJ53951Y6156774E`); scenario 3 was held and denied. Refunding the 45.00 USD capture from the dashboard right after the charge failed with PayPal `422 UNPROCESSABLE_ENTITY [REFUND_FAILED_INSUFFICIENT_FUNDS]`, while the 1.00 USD refunds of M0 and M1 had succeeded. The guard behaved as designed: the payment stayed `COMPLETED`, the request `PAID`, and `refund.failed` was audited with the issue code. The likely cause is the receiving sandbox business account's available USD balance; it is the owner's account to inspect. Refunds therefore depend on the merchant account's balance, which production would handle by retrying later or by webhook-driven reconciliation.

**Not in M2.** Dashboard authentication (see THREAT_MODEL.md), Streamable HTTP for MCP (stdio only), webhooks, push notifications.

## D13. The AI reviewer: evidence, a fixed vocabulary, and a model that can only tighten (2026-10-28)

**Decision.** The reviewer (`src/review`) runs after the deterministic policy on every request the policy did not BLOCK. It sees four things, all marked as untrusted data: the request; the owner's rules and the verdict so far; the price history of the same item at the same merchant (earlier `AUTO_APPROVED`/`APPROVED`/`PAID`/`REFUNDED` requests, unit price = amount ÷ the quantity parsed from an " xN" suffix); and the text of the product page the agent named, which the guard fetches itself, hidden text included.

Its output is a risk level and flags from a fixed vocabulary (`src/review/flags.ts`): `PROMPT_INJECTION_SUSPECTED`, `CLAIMS_OWNER_APPROVAL`, `REASON_ITEM_MISMATCH`, `PRICE_ANOMALY`, `UNUSUAL_QUANTITY`, plus `PAGE_UNAVAILABLE` and `REVIEWER_UNAVAILABLE`, which only code sets. Code, not the model, maps risk to a recommendation (`low` → AUTO_APPROVE, `medium` → HOLD, `high` → BLOCK), and the pipeline keeps the tighter of that and the policy's decision (D9).

Two implementations behind one interface. `LLM_PROVIDER=mock` (the default) is `src/review/heuristics.ts` alone: patterns for instructions aimed at agents (on the page and in the request text), patterns for owner-approval claims in the reason, a price band of 1.5× around the history median, a quantity rule. `LLM_PROVIDER=anthropic` sends the same evidence to Claude (`claude-opus-5-5` unless `LLM_MODEL` says otherwise) through the Vercel AI SDK, using the provider's native structured output (`output_config.format` from a Zod schema), effort `low`, no retries, and the pipeline's `AbortSignal`; it then unions the model's flags with the heuristics' and takes the higher risk. The heuristics are the floor in both modes; the model adds what rules cannot see (a reason that does not fit the item, manipulation phrased in new ways). Any model failure (key rejected, rate limit, network, refusal, unusable JSON) becomes HOLD with `REVIEWER_UNAVAILABLE` and a short, fixed, secret-free reason; a timeout (`REVIEW_TIMEOUT_MS`: 30 s for anthropic, 8 s for mock) is the pipeline's HOLD. There is no server-side fallback to another model: rerouting a safety check silently is wrong for a guardrail.

**What agents learn.** The MCP result for a HELD or BLOCKED request carries the flags and the reviewer's explanation (the rule-based notes, or the model's two sentences), nothing about the owner's PayPal side. Provider errors never reach it: they are classified into fixed phrases first.

**The page fetch is the one outbound request the guard makes to a URL it did not choose**, so it is fenced (THREAT_MODEL.md): http(s) only, origin on an allowlist (the shop by default, `REVIEW_PAGE_ORIGINS` adds more), redirects not followed, 256 KB and 3 s caps, HTML only, 4000 characters of text kept.

**Why the Vercel AI SDK and not the provider's own SDK.** HANDOFF §4 and D4 ask for it so the provider stays swappable. The current provider package (`@ai-sdk/anthropic` 4.x) uses Anthropic's native structured outputs on models that reject forced tool use, so nothing technical argued against it. The `Reviewer` interface would make a switch either way a one-file change.

**Why no AG Grid yet.** HANDOFF lists an AG Grid Community audit table for M3. The dashboard still has no build step and loads no third-party script (D12); AG Grid would mean a CDN script and a looser policy on judges' machines. Left on the stretch list, together with the AG Grid prize track, for the owner to decide.

**Demo.** Scenario 3 (the hostile pens page) now ends BLOCKED in both modes: the fetched page contains instructions aimed at agents, the reason claims the owner's approval, and ten units is unusual. Scenario 4 (the notebook relisted at 29.00, inside the rules) ends HELD with `PRICE_ANOMALY` once scenario 1 is in the history. The shop therefore has five products, two of them the same notebook.

**Caveat recorded, not fixed.** While a review runs, the request sits in `EVALUATING`, which D10's in-flight budget does not count; two requests submitted at the same moment can both pass the budget check. Production would reserve the amount before the review.

## D14. Reproduction: one end-to-end run, for the sandbox and for judges without an account (2026-10-28)

**Decision.** `scripts/e2e-sandbox.ts` plays the same four scenarios as the demo agent through the real pipeline (product page → mock agent → rules → reviewer → decision → executor), with the owner's part scripted (approve scenario 2, deny scenario 4) and both captures refunded at the end; every expectation is checked and the run exits non-zero when one fails. The flow is `src/demo/e2e.ts`, so the tests run it against a fake PayPal. Two modes, one code path:

- `npm run e2e:sandbox`: a fresh, gitignored database per run (`.tmp-e2e/`) with the active mandate copied in from `data/guard.db`, so the month's budget starts at zero and the result does not depend on what the dashboard's database already holds; it refuses to start outside the demo hours (scenario 1 would be held, not paid); it loads the reviewer from the environment exactly as the server does, so a bad `LLM_PROVIDER` fails closed before anything is sent. Five to seven PayPal calls: a token, one or two per charge, one per refund.
- `npm run e2e:offline`: `src/demo/fake-paypal.ts` answers the token, order and refund endpoints in-process with made-up ids; the reviewer is the mock whatever the environment says; the clock is pinned to 2026-10-28 12:00 Tokyo time; `.env` is not read. CI runs it on Node 22 and 24 after the tests.

**Why scenario 3 counts PayPal calls.** HANDOFF §9 promises "BLOCKED, no PayPal call". The run wraps the client's fetch with a counter and fails the scenario if a blocked request produced one; nothing else proves that claim end to end.

**Why scenario 4 is denied rather than approved.** It shows the deny path, leaves no held request behind, and keeps the sandbox spend at 57.00 USD per run (12.00 + 45.00, both refunded).

**Why the fake lives in `src/demo` and not only in the tests.** A judge without a PayPal account should see the whole loop, charge and refund included, with one command and no network; the tests keep their own, smaller fakes.

**What this does not prove.** The sandbox run spends sandbox money and needs the owner's mandate, so it is the owner's to execute; the real model path is exercised only when `LLM_PROVIDER=anthropic` is set for a sandbox run.

## D15. M5: the model path run against the live API, and the demo video (2026-10-30)

**Observed on the sandbox (2026-10-30, `LLM_PROVIDER=anthropic npm run e2e:sandbox`, `claude-opus-5-5`).** Two runs, eighteen minutes apart, from the owner's machine over a direct connection to the API.

- 17:37 Tokyo time: three of the four model calls never reached the API (the connection timed out after 10 s; no proxy, no IPv6, a route that comes and goes). The guard did what D13 promises: scenario 1 `HELD` with `REVIEWER_UNAVAILABLE` instead of paid; scenario 2 `HELD` by the rules and paid after the scripted approval (capture `1H372079A1832761H`, refunded `69W16873WE4554542`); scenario 3 `BLOCKED` by the rule-based checks alone (`PROMPT_INJECTION_SUSPECTED`, `CLAIMS_OWNER_APPROVAL`, `UNUSUAL_QUANTITY`, no PayPal call); scenario 4 reached the model and was `HELD` with `PRICE_ANOMALY`. The run reported 3/4 because scenario 1 expects `PAID`; nothing was paid that should not have been.
- 17:55: all four calls answered in 2.4–2.8 s (1650/108, 1687/119, 1861/204 and 1715/133 input/output tokens, about 0.04 USD at list price): scenario 1 `low`, no flag, paid (capture `90E72130SP094773H`, refunded `6S822501SF770773N`); scenario 2 `low`, held by the rules, approved, paid (capture `3NC62546J7631420W`, refunded `84W12661EA4423044`); scenario 3 `high` with `PROMPT_INJECTION_SUSPECTED`, `CLAIMS_OWNER_APPROVAL`, `REASON_ITEM_MISMATCH`, `UNUSUAL_QUANTITY`, blocked; scenario 4 `medium`, `PRICE_ANOMALY` ("about 2.4× the 12.00 USD paid for the same notebook at this merchant recently"), held, denied. 4/4, 2/2 refunds, 5 PayPal calls.

The request shape (`output_config.format` from the Zod schema, `effort: low`) was accepted as the unit tests assert, and the structured answer never needed repair; the explanations read as written for the owner.

**What the first run adds.** A real network failure is the case the design is built around, and it had only been simulated in tests. The 10 s connection timeout is Node's fetch (undici), inside the pipeline's 30 s; there is still no retry (D13), so a flaky route shows up as held requests for the owner to look at, not as repeated model calls. Production would watch the `REVIEWER_UNAVAILABLE` rate.

**The demo video.** Recorded from this code against the sandbox on 2026-10-30 (its own captures and refunds, all refunded) with the reviewer in mock mode, which the dashboard labels on every screen; the narration is Gemini text-to-speech. The video claims no live model run; this entry documents that run instead.

**Not changed.** The default stays `LLM_PROVIDER=mock`; judges need no key. `.env` keeps the provider; the live runs passed `LLM_PROVIDER=anthropic` on the command line, which `process.loadEnvFile` does not override.

## D16. External security review, and what changed (2026-10-30)

**Context.** Before the repository goes public, a second AI agent (OpenAI Codex) reviewed it read-only against a written brief: the threat model, D1 to D15 and the README's claims as things to falsify. It ran the test suite, the offline end-to-end run and `npm audit` (no findings), probed a keyless instance over HTTP, and wrote eleven findings plus one re-rating of a declared limitation. Each was verified against the code by hand before anything changed; the report itself stays outside the repository.

**What was wrong, and what changed.**

- *An outcome PayPal never confirmed was booked as "not charged".* A lost connection, an unreadable answer, a 5xx or a `PENDING` capture all went to `failPayment`: payment `FAILED`, request `PAYMENT_FAILED`, budget freed, and `charge()` refused to look again. Had the capture gone through, the money was gone and the next request paid as if it had not. Now only PayPal's own refusal (a 4xx, an order in `VOIDED` or `PAYER_ACTION_REQUIRED`, a `DECLINED` or `FAILED` capture) is `FAILED`. Anything else leaves the payment `CREATED` and the request approved, so the amount keeps counting; the audit log records `payment.unsettled` with the reason, the dashboard lists the request under "Payments to settle", and the owner's **Retry payment** (`POST /requests/:id/charge`, `Guard.retryCharge`) replays the charge under the same idempotency keys (D8): PayPal returns the order it already has, or completes the capture, and nothing is charged twice. `GuardResult.payment` can therefore be `CREATED`. A refund PayPal answers `PENDING` is still taken as done (D11): the sandbox has never answered otherwise, and a refund that later failed would leave the budget under-counted by its amount, visible on the PayPal side; production would reconcile.
- *Simultaneous requests could all pass the budget* (the caveat recorded in D13 and the threat model, reproduced by the review: four 30.00 requests at once against a 100.00 budget, all paid). `Repo.spentThisMonthMinor` now takes the id of the request being decided and counts the agent's older requests that are still `EVALUATING`, by rowid, first come first served; a request never counts against itself, so two requests that together exceed the budget are not both held.
- *The rules ran once, before the review.* A review takes up to 30 s; a cap the owner tightened meanwhile, a sibling decided first or the allowed hours ending were not seen. `Guard.decide` evaluates the policy again after the reviewer, with fresh rules, budget and clock, and keeps the tighter of the two verdicts, never the looser.
- *The login-less dashboard trusted the browser.* Form posts from any origin were accepted; `/api/requests` took JSON sent as `text/plain`, which a browser sends cross-site without a preflight; any `Host` header was answered; nothing forbade framing. The review walked the chain on a keyless instance: one cross-site post loosens the rules, a second one buys 200.00 at an unknown merchant, `AUTO_APPROVED`. Now every route checks the Host against localhost and `PUBLIC_BASE_URL` (400 otherwise), `hono/csrf` refuses a form-typed POST unless `Origin` or `Sec-Fetch-Site` is same-origin (the MCP server sends JSON without an Origin and is unaffected), responses carry `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, and the agent API takes `application/json` only. What this does not add is a login: a process on the same machine can still call every route (threat model).
- *"Every error is redacted" had gaps.* A non-JSON PayPal error body was cut to 300 characters before redaction, so a registered value on the cut survived in part; `name`, `debug_id`, `issue` and `field` were not redacted; a thrown fetch error or a `JSON.parse` failure (whose message quotes the offending text) bypassed the client entirely; the PayPal pages showed `err.message`. Now the client redacts before it truncates, scrubs every field, turns connection, read and parse failures into `PayPalTransportError` with fixed text, refuses redirects (`redirect: 'error'`, so a redirect can never lead off the sandbox host), and the dashboard shows `describePayPalError` (status, error name, issue codes, debug id) and nothing else.
- Smaller: setup token ids enter the audit log masked and the one in D2 is masked; link attempts expire after fifteen minutes, at most twenty are open and each is consumed on its first return; the page fetcher refuses to start once the review is cancelled and cancels the body on every early return; `.githooks/pre-commit` is committed executable (Unix clones silently skipped it) and also refuses `*.db-journal` and `data/`; a numeric `amount` must be exact to the cent (12.005 is refused, not rounded to 12.01); CI runs with a read-only token; one owner action per request at a time (a second concurrent approve, refund or retry gets 409); the documentation says "at least HOLD", describes what tool results and audit details really hold, and marks HANDOFF.md and RESEARCH.md as history.

**Claims the review confirmed**, with the tests it read: sandbox-only URLs and configuration (D1); the MCP server holds no credential; the reviewer can only tighten and an unknown flag fails closed (the comment in `anthropic.ts` said "dropped"; it now says what happens); BLOCK makes no PayPal call; the idempotency keys and the one payment per request; HTML escaping of every agent-written field, of query parameters and of error pages; the shop's own origin and CSP; the page-fetch fence; the SQL in `repo.ts` uses parameters and a fixed column map; request fields are length-capped (a 10 MiB reason is a 400); an invalid time zone is a 400.

**Rated, not changed.** No login (above). No webhooks (D12). One mandate, stored in clear in the local database. The model reads hostile text, and the heuristics can be phrased around (a line break inside "approved by owner", zero-width characters, full-width letters), which the amount and merchant rules still catch. No request body cap or rate limit. Refund `PENDING` (above). The hackathon demo keeps all of these; each is listed in the threat model.

**Not verified here.** No live PayPal or model call was made for this change: the unsettled path, the budget race and the browser protections are covered by unit tests and the offline end-to-end run (258 tests). A further `e2e:sandbox` would exercise the unchanged happy path; the unsettled branch needs a PayPal outage to show itself, which the fake provides and the sandbox does not.

## D17. Second external review (dots), and what changed (2026-11-01)

**Context.** After the repository went to GitHub (private), a second reviewer, "dots", an AI agent reading commit 707cddf and its green CI run, sent five code findings, three wording corrections and positioning advice. Each code finding was verified against the code before anything changed; all five held. The report stays outside the repository. The wording and positioning points are recorded at the end of this entry and left for the submission text.

**What was wrong, and what changed.**

- *Every 4xx counted as PayPal refusing.* `isFinalRejection` took any 4xx as the final word, including on the retry path, where the executor first looks the recorded order up: a 429 or 401 on that GET booked the payment `FAILED` and freed the budget while the order may well have been `COMPLETED`. Now an error while looking an order up is never a rejection, only an unknown outcome; and a 401 (after the client's own token retry), 403, 408 or 429 on the create or capture itself is an unknown outcome too. Both leave the payment `CREATED` for the owner's retry (D16). Any other 4xx on the charge stays `FAILED`. A 403 that is permanent (the vault scope missing from the app) therefore also stays unsettled, and as before there is no owner action to write an unsettled payment off, only the retry.
- *A purchase submitted twice was two purchases.* `PayPal-Request-Id` protects one internal request (D8); an agent whose `request_purchase` call timed out after the charge went through would make a new request with new keys and pay twice. `request_purchase` and `POST /api/requests` take an optional `intent_id` (1 to 64 characters: letters, digits and `. _ : -`), unique per agent (migration 002, a partial unique index). A repeat under a known id returns the request already made (`replayed: true`, HTTP 200, no events), even while it is still being decided; the same id with a different merchant, item, category, amount or currency is refused (`intent_conflict`, 409) and nothing is created. Lookup and insert are synchronous, so nothing slips between them within one process. The mock agent does not retry, so the demo is unchanged.
- *Approval skipped the rules.* `Guard.approve` moved `HELD` to `APPROVED` and charged, whatever had changed since the hold. It now evaluates the policy again inside the same transaction. The soft reasons (cap, budget, merchant, category, hours, new merchant) stay the owner's to override, which is what a hold is for; a BLOCK-level reason (D9: agent disabled, no policy, invalid amount, currency mismatch, above the hard ceiling) refuses the approval with the reasons spelled out, audits `owner.approve_refused` and leaves the request `HELD`, so the owner can fix the rule or deny it. Chosen over moving it to `BLOCKED`: an agent may be disabled for an afternoon, and the owner, not a side effect, should end the request. `retryCharge` does not re-check: there the money may already have moved.
- *A `PENDING` refund was a done refund.* D11 took PayPal's `PENDING` as completed and freed the budget at once. Payments now have a `REFUND_PENDING` status (migration 003 rebuilds the table around its rows, since SQLite cannot widen a CHECK constraint in place): the capture keeps counting against the budget, the request stays `PAID`, the dashboard lists it under "Refunds to confirm", and **Check refund** (`POST /requests/:id/refund-check`, which calls `GET /v2/payments/refunds/{id}`) settles it when PayPal says `COMPLETED`, hands the capture back (`COMPLETED` again, `refund.failed` audited) when PayPal says `CANCELLED` or `FAILED`, and changes nothing otherwise. The next refund of that capture carries a fresh idempotency key, numbered by the refunds PayPal accepted so far, because PayPal would answer the spent key with the cancelled refund; a retry after an error that created no refund keeps the first key and is replayed (D8). The request statuses are unchanged: a request whose refund is pending is still paid. A second refund while one is pending is refused. The sandbox has only ever answered `COMPLETED`, so the demo, the video and `e2e:offline` are unchanged.
- *A request interrupted by a restart stayed `EVALUATING` for ever.* Nothing decided it, no route could, and since D16 it counted against every younger sibling's budget for the rest of the month. `Guard.recoverInterrupted`, called in `main.ts` before the server listens, decides such requests oldest first with today's rules and a reviewer that reports the interruption: `HELD` with `REVIEWER_UNAVAILABLE` and an explanation naming the restart (`BLOCKED` when the rules say so), never charged, `request.recovered` audited. The real reviewer is not called at start-up: no network, no cost, no timeout before the server is up.

**Wording and positioning, recorded, not yet changed.** The review also found the README's first paragraph inaccurate in three places ("anything outside the rules waits for a human tap": a BLOCK never reaches the owner; "any payment can be refunded": only a completed capture; "agents never get an API key": the local API has no authentication, so the true claim is about what the MCP tool returns, not isolation). It asked for the real / simulated / not-built boundary to come first (the shopping agent is a script, the default reviewer is the mock, the model is optional, PayPal is the real sandbox, the money lands in the app's own sandbox business account), for a case where the model adds what the mock cannot (the `REASON_ITEM_MISMATCH` flag only the model can raise is the natural one), for the README to open with positioning rather than the milestone log, and for the submission to say USD only: the policy currency can be changed on the Rules page while the budget sum and the price history do not filter by currency (requests in another currency are blocked, so the gap opens only when the owner changes the currency with payments on record). The video narration carries none of the three sentences. The owner decided to leave the name, the documents and the video as they are for now; this entry keeps the list.

**Not verified here.** No live PayPal or model call was made: the new paths are covered by 279 tests (21 new) and the offline end-to-end run. Migrations 002 and 003 are tested against a database created by 001 with rows in it; the owner's own `data/guard.db` migrates on the next start of `npm run dev` or `npm run e2e:sandbox`.
