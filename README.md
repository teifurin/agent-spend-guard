# agent-spend-guard

**A payment guardrail between AI agents and PayPal.** Agents never get a wallet, a card or an API key. They get one tool, `request_purchase`. The guard checks each request against the owner's rules, has an AI reviewer look for anything fishy, and only then charges PayPal. Anything outside the rules waits for a human tap. Everything is logged, and anything can be refunded with one click.

> Status: **M0** and **M1** done (2026-10-28). Both sandbox spikes passed ([D2](docs/DECISIONS.md)); the policy engine, decision pipeline and PayPal executor are in, tested, and proven with one real sandbox charge through the stored mandate and its refund ([D11](docs/DECISIONS.md)). **M2** next: MCP server, demo shopping agent, synthetic shop, owner dashboard. PayPal AI Hackathon 2026 entry.
> Runs against the PayPal **sandbox only**. Every merchant, product and price in the demo is **synthetic**.

## The problem

AI agents can already browse and buy. Nobody hands one their whole PayPal balance. The official PayPal Agent Toolkit lets you switch whole actions on or off, but has no notion of "up to $30 a time, $100 a month, only at these two shops, not at 3 am, and ask me if anything looks odd."

## How it works (target design)

```
agent ──MCP request_purchase──▶ Guard ─▶ 1. policy engine (deterministic caps, budget, allowlists, time windows)
                                        2. AI risk reviewer (may only tighten: allow → hold / block)
                                        3. decision: AUTO_APPROVE · HOLD (owner approves on their phone) · BLOCK
                                        4. PayPal sandbox: one-time mandate (vault) → charge → refund
                                        5. SQLite audit log → owner dashboard
```

Key properties:

- **Agents never see PayPal credentials or tokens.** They receive statuses and ids only.
- **Rules are the floor; the AI can only tighten.** An over-budget request cannot be talked through, and an LLM failure means HOLD.
- **Product pages are data, not instructions.** The demo includes a synthetic malicious page whose hidden text tries to raise the limit; the reviewer flags it and the policy engine ignores it.
- **Sandbox only, by construction.** The sandbox host is hard-coded and the process refuses to start with `PAYPAL_ENV` set to anything else.

Full plan: [docs/HANDOFF.md](docs/HANDOFF.md). Decisions and open questions: [docs/DECISIONS.md](docs/DECISIONS.md).

## M0: run the sandbox spike

Prerequisites: Node 22.13 or newer and a free [PayPal developer](https://developer.paypal.com/) account.

1. In the Developer Dashboard create a **sandbox** REST app. Under *Sandbox App Settings* enable **Accept payments**, then open *Advanced options* and tick **Vault**. Note the client id and secret.
2. Find the auto-generated **personal** (buyer) sandbox account under *Testing Tools → Sandbox Accounts*. You will log in with it on PayPal's approval page.
3. Configure and verify:

   ```bash
   cp .env.example .env     # then fill in PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET
   npm ci
   npm run check-env        # prints each key as set/missing, never a value
   npm test
   ```

4. Prove that money can move, both ways:

   ```bash
   npm run spike:vault      # Plan A: approve once, charge $1.00 with the buyer absent, refund
   npm run spike:order      # Plan B: approve this one order in PayPal, capture, refund
   ```

   Each prints an approval URL; open it and log in with the sandbox **personal** account. The script notices the approval (browser redirect, Enter, or status polling), finishes the charge and refunds it. It prints statuses and PayPal ids only.

## M1: run the guard end to end on the sandbox

After a successful `spike:vault`, store its mandate (the vault id it saved in the gitignored `.spike-state.json`) and send one synthetic request through the whole pipeline:

```bash
npm run link-paypal -- --from-spike-state   # no network: writes the mandate to data/guard.db
npm run e2e:sandbox                          # policy -> AUTO_APPROVE -> vault charge -> PAID -> refund -> REFUNDED
```

`e2e:sandbox` seeds a synthetic demo agent with a policy (30.00 USD per purchase, 100.00 USD per month, two synthetic merchants), submits a 1.00 USD request, charges it through the mandate with the buyer absent, refunds it, and prints the decision, the PayPal ids and the audit trail. Three or four PayPal calls per run. `--amount 2.50` changes the amount, `--skip-refund` keeps the capture.

## Security model

- Secrets live only in `.env` (gitignored). Nothing reads it except the process itself; `npm run check-env` reports set/missing only.
- The vault id lives only in the database (`data/guard.db`, gitignored together with its `-wal`/`-shm` files) and in `.spike-state.json`. The executor registers it with the redactor before every PayPal call, audit entries carry PayPal object ids and the guard's own mandate id only, and tests assert the vault id appears nowhere visible.
- The PayPal client redacts bearer tokens, basic-auth values and the configured credentials from every error it raises (tested).
- `PayPal-Request-Id` is derived from our own request ids, so retries cannot double-charge (tested).
- `.githooks/pre-commit` refuses `.env*` and database files and runs [gitleaks](https://github.com/gitleaks/gitleaks) when installed; CI runs gitleaks over the full history.

## Layout

```
scripts/   check-env.ts, spike-vault.ts (M0), link-paypal.ts, e2e-sandbox.ts (M1)
src/
  config/  .env loading (Node's built-in parser, nothing is ever printed)
  domain/  types, money (integer minor units), name normalization
  policy/  deterministic engine, reason codes with severities, time-zone helpers, policy validation
  db/      node:sqlite connection, migrations/001_init.sql, Repo (agents, policies, requests, decisions, payments, mandates, audit)
  paypal/  sandbox-only REST client, redaction, Orders v2 / Payments v2 calls with idempotency keys
  guard/   decision pipeline (policy -> reviewer hook -> decision -> charge), PayPal executor
tests/     Vitest unit tests (PayPal is a fake fetch; no network)
docs/      HANDOFF.md (full plan), RESEARCH.md (sources), DECISIONS.md
```

How the guard decides and pays is written down in [docs/DECISIONS.md](docs/DECISIONS.md) (D9: HOLD vs BLOCK, D10: budget accounting, D11: the executor).

Coming next (M2–M3): MCP server with `request_purchase`, demo shopping agent, synthetic mock shop, owner dashboard with approve/deny and refund, AI risk reviewer.

Note for Node 22.x: the database uses the built-in `node:sqlite`, which prints a one-line `ExperimentalWarning` on 22.x. It is harmless; Node 24 prints nothing.

## AI tools used

Built with Claude Code (Anthropic) for code, tests and docs, reviewed by a human before merge. The initial research and plan were drafted with Grok. The runtime LLM provider is configurable; `LLM_PROVIDER=mock` runs the whole demo without any key.

## License

MIT. See [LICENSE](LICENSE).
