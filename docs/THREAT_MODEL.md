# Threat model

What the guard protects against, what it deliberately leaves out for a hackathon demo, and what production would add.

## Assets

- The owner's money: the PayPal mandate (vault id) and the ability to charge it.
- The PayPal sandbox credentials in `.env`.
- The integrity of decisions: a request must never be paid unless the owner's rules (and, from M3, the AI reviewer) allowed it or the owner approved it.

## Trust boundaries

| Component | Trusts | Holds |
| --- | --- | --- |
| Shopping agent (LLM or mock) | nothing it reads on the web | no credential, no token, no database. Only MCP tool results: statuses and ids |
| MCP server (`src/mcp`) | the guard's JSON API | no credential; it does not even load `.env` |
| Guard server (`src/server`, `src/guard`) | its database and the owner | `.env` (sandbox credentials), the database with the vault id |
| Synthetic shop (`src/shop`) | nothing; it is the hostile party in the demo | static pages, no scripts, strict CSP, own origin |

## Threats covered

- **Prompt injection through product pages.** Merchant text is data. The deterministic engine never reads it as instructions; the dashboard escapes every request field (tested with script, event-handler and `javascript:` payloads); the shop runs on a separate origin from the dashboard. The M3 reviewer flags suspicious text and can only tighten a decision.
- **An agent spending beyond its rules.** Caps, monthly budget, allowlists and hours are enforced before any PayPal call; the AI reviewer cannot loosen them; an LLM failure means HOLD.
- **Credential leakage.** Secrets live only in `.env`; the client redacts bearer, basic-auth and configured values from every error; the executor registers the vault id with the redactor before each call; audit details carry PayPal object ids only (tested); database and state files are gitignored and refused by the pre-commit hook; gitleaks runs in CI.
- **Double charging.** Every create, capture and refund carries a `PayPal-Request-Id` derived from the request id; a crash between steps is resumed by looking up the recorded order instead of re-creating it.
- **Live money.** The sandbox host is hard-coded; the process refuses to start when `PAYPAL_ENV` is anything but `SANDBOX`.

## Out of scope for the demo (and what production would add)

- **No authentication on the dashboard or the agent API.** Anyone who can reach the guard's port can submit requests as any agent or approve a held one. The server binds to `127.0.0.1` by default; `HOST=0.0.0.0` is for showing the dashboard on a phone on the same Wi-Fi during the demo. Production: owner login with a second factor, per-agent API keys or mTLS for the MCP server, CSRF tokens on dashboard forms, rate limits.
- **No webhooks.** Settlement is read from the synchronous API responses. Production: `PAYMENT.CAPTURE.COMPLETED` / `REFUNDED` webhooks with signature verification, and reconciliation.
- **One owner, one mandate.** The database holds the single active mandate; a multi-tenant deployment would scope mandates, agents and policies per owner and encrypt the vault id at rest.
- **Synthetic everything.** No real merchant receives money (DECISIONS D3): the guard is a wallet operator that charges the owner's PayPal into its own sandbox business account.
