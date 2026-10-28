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
| AI reviewer (`src/review`) | nothing it reads: the request, the page and the history are data | the LLM key in anthropic mode (handed to the provider, registered with the redactor); it returns a schema-bound verdict that code can only tighten |
| Synthetic shop (`src/shop`) | nothing; it is the hostile party in the demo | static pages, no scripts, strict CSP, own origin |

## Threats covered

- **Prompt injection through product pages.** Merchant text is data. The deterministic engine never reads it as instructions; the dashboard escapes every request field (tested with script, event-handler and `javascript:` payloads); the shop runs on a separate origin from the dashboard. The reviewer reads the page the agent read, hidden text included, flags instructions aimed at agents (`PROMPT_INJECTION_SUSPECTED`) and reasons that claim an approval the agent cannot have (`CLAIMS_OWNER_APPROVAL`), and can only tighten a decision; in anthropic mode the page goes to the model inside tags marked as untrusted, with angle brackets neutralised so it cannot close a section (tested).
- **An agent spending beyond its rules.** Caps, monthly budget, allowlists and hours are enforced before any PayPal call; the AI reviewer cannot loosen them; an LLM failure, refusal, timeout or unusable answer means HOLD (tested against a fake provider).
- **The reviewer fetching agent-supplied URLs (server-side request forgery).** `source_url` comes from the agent, and the guard fetches it to see what the agent saw. The fetch is fenced (`src/review/page.ts`, tested): http(s) only, origin on an allowlist (the synthetic shop by default, `REVIEW_PAGE_ORIGINS` adds more), redirects never followed, 256 KB and 3 s caps, HTML only. A URL outside the allowlist is not requested at all; the request is reviewed without the page and carries `PAGE_UNAVAILABLE`.
- **Credential leakage.** Secrets live only in `.env`; the client redacts bearer, basic-auth and configured values from every error; the executor registers the vault id with the redactor before each call; audit details carry PayPal object ids only (tested); the LLM key is read once, handed to the provider and registered with the redactor, and provider error bodies are never stored or shown: failures are classified into fixed phrases (tested with a 401 whose body contains the key); database and state files are gitignored and refused by the pre-commit hook; gitleaks runs in CI.
- **Double charging.** Every create, capture and refund carries a `PayPal-Request-Id` derived from the request id; a crash between steps is resumed by looking up the recorded order instead of re-creating it.
- **Live money.** The sandbox host is hard-coded; the process refuses to start when `PAYPAL_ENV` is anything but `SANDBOX`.

## Out of scope for the demo (and what production would add)

- **No authentication on the dashboard or the agent API.** Anyone who can reach the guard's port can submit requests as any agent or approve a held one. The server binds to `127.0.0.1` by default; `HOST=0.0.0.0` is for showing the dashboard on a phone on the same Wi-Fi during the demo. Production: owner login with a second factor, per-agent API keys or mTLS for the MCP server, CSRF tokens on dashboard forms, rate limits.
- **No webhooks.** Settlement is read from the synchronous API responses. Production: `PAYMENT.CAPTURE.COMPLETED` / `REFUNDED` webhooks with signature verification, and reconciliation.
- **One owner, one mandate.** The database holds the single active mandate; a multi-tenant deployment would scope mandates, agents and policies per owner and encrypt the vault id at rest.
- **The model reads hostile text.** A page could be written to talk the model into a lower risk. That is why the deterministic checks are a floor the model cannot lower, the risk-to-decision mapping lives in code, and the model's only outputs are an enum, a list from a fixed vocabulary, a boolean and two sentences. Production would add a second, cheaper classifier on the page text alone and evaluation sets of hostile pages.
- **A review takes time.** While it runs the request is `EVALUATING`, which the in-flight budget (D10) does not count, so two requests submitted at the same moment can both pass the budget check. Production would reserve the amount before the review.
- **Synthetic everything.** No real merchant receives money (DECISIONS D3): the guard is a wallet operator that charges the owner's PayPal into its own sandbox business account.
