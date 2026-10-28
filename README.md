# agent-spend-guard

**A payment guardrail between AI agents and PayPal.** Agents never get a wallet, a card or an API key. They get one tool, `request_purchase`. The guard checks each request against the owner's rules, has an AI reviewer look for anything fishy, and only then charges PayPal. Anything outside the rules waits for a human tap. Everything is logged, and anything can be refunded with one click.

> Status: **M0** done; both sandbox spikes passed on 2026-10-28 (a vault charge with the buyer absent, and a per-order approval; see [D2](docs/DECISIONS.md)). **M1** in progress: policy engine, reason codes and SQLite schema are in and tested; the PayPal executor is next. PayPal AI Hackathon 2026 entry.
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

## Security model (M0)

- Secrets live only in `.env` (gitignored). Nothing reads it except the process itself; `npm run check-env` reports set/missing only.
- The PayPal client redacts bearer tokens, basic-auth values and the configured credentials from every error it raises (tested).
- `PayPal-Request-Id` is derived from our own request ids, so retries cannot double-charge (tested).
- `.githooks/pre-commit` refuses `.env*` and database files and runs [gitleaks](https://github.com/gitleaks/gitleaks) when installed; CI runs gitleaks over the full history.

## Layout

```
scripts/   check-env.ts, spike-vault.ts (M0)
src/
  config/  .env loading (Node's built-in parser, nothing is ever printed)
  domain/  types, money (integer minor units), name normalization
  policy/  deterministic engine, reason codes with severities, time-zone helpers, policy validation
  db/      node:sqlite connection, migrations/001_init.sql, Repo (agents, policies, requests, decisions, payments, audit)
  paypal/  sandbox-only REST client, redaction
tests/     Vitest unit tests (PayPal is mocked; no network)
docs/      HANDOFF.md (full plan), RESEARCH.md (sources), DECISIONS.md
```

How the policy engine decides is written down in [docs/DECISIONS.md](docs/DECISIONS.md) (D9: HOLD vs BLOCK, D10: budget accounting).

Coming next (M2–M3): PayPal executor, MCP server, demo shopping agent, synthetic mock shop, AI risk reviewer, owner dashboard.

Note for Node 22.x: the database uses the built-in `node:sqlite`, which prints a one-line `ExperimentalWarning` on 22.x. It is harmless; Node 24 prints nothing.

## AI tools used

Built with Claude Code (Anthropic) for code, tests and docs, reviewed by a human before merge. The initial research and plan were drafted with Grok. The runtime LLM provider is configurable; `LLM_PROVIDER=mock` runs the whole demo without any key.

## License

MIT. See [LICENSE](LICENSE).
