-- agent-spend-guard schema, migration 001.
-- Conventions: timestamps are INTEGER epoch milliseconds (UTC); amounts are INTEGER minor units;
-- booleans are 0/1; lists are JSON text. Status columns carry CHECK constraints so a typo fails at insert.

CREATE TABLE agents (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
);

-- One policy per agent. The engine reads it; the owner edits it from the dashboard.
CREATE TABLE policies (
  agent_id             TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  currency             TEXT NOT NULL,
  max_tx_minor         INTEGER NOT NULL CHECK (max_tx_minor > 0),
  hard_max_tx_minor    INTEGER CHECK (hard_max_tx_minor IS NULL OR hard_max_tx_minor >= max_tx_minor),
  monthly_budget_minor INTEGER NOT NULL CHECK (monthly_budget_minor > 0),
  merchant_allowlist   TEXT,            -- JSON array of normalized names; NULL = any merchant
  category_allowlist   TEXT,            -- JSON array of normalized names; NULL = any category
  hours_start          TEXT,            -- 'HH:MM' local time in `timezone`; NULL = any time
  hours_end            TEXT,
  timezone             TEXT NOT NULL,   -- IANA zone for the budget month and the hours window
  hold_new_merchants   INTEGER NOT NULL DEFAULT 1 CHECK (hold_new_merchants IN (0, 1)),
  updated_at           INTEGER NOT NULL
);

-- What an agent asked for. `reason` and `source_url` come from the agent and are untrusted text.
CREATE TABLE requests (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  merchant     TEXT NOT NULL,
  merchant_key TEXT NOT NULL,           -- normalized merchant name, for matching and history
  item         TEXT NOT NULL,
  category     TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  source_url   TEXT,
  status       TEXT NOT NULL CHECK (status IN (
                 'EVALUATING', 'AUTO_APPROVED', 'HELD', 'BLOCKED', 'APPROVED', 'DENIED',
                 'PAID', 'PAYMENT_FAILED', 'REFUNDED')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX requests_agent_status  ON requests(agent_id, status);
CREATE INDEX requests_agent_created ON requests(agent_id, created_at);

-- One row per evaluation of a request: the deterministic policy verdict, then the AI review that may only tighten it.
CREATE TABLE decisions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id         TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  policy_verdict     TEXT NOT NULL CHECK (policy_verdict IN ('ALLOW', 'HOLD', 'BLOCK')),
  policy_reasons     TEXT NOT NULL,     -- JSON array of {code, message}
  review_risk        TEXT CHECK (review_risk IS NULL OR review_risk IN ('low', 'medium', 'high')),
  review_flags       TEXT NOT NULL DEFAULT '[]',
  review_explanation TEXT,
  final_decision     TEXT NOT NULL CHECK (final_decision IN ('AUTO_APPROVE', 'HOLD', 'BLOCK')),
  decided_by         TEXT NOT NULL CHECK (decided_by IN ('policy', 'reviewer')),
  decided_at         INTEGER NOT NULL
);
CREATE INDEX decisions_request ON decisions(request_id);

-- One PayPal charge per request. Holds PayPal object ids only, never tokens.
CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL UNIQUE REFERENCES requests(id),
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  paypal_order_id   TEXT,
  paypal_capture_id TEXT,
  paypal_refund_id  TEXT,
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('CREATED', 'COMPLETED', 'FAILED', 'REFUNDED')),
  captured_at       INTEGER,            -- set when status becomes COMPLETED; drives the monthly budget
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX payments_agent_captured ON payments(agent_id, status, captured_at);

-- The owner's one-time PayPal authorization (Plan A). The vault id stays on the guard's side only.
CREATE TABLE mandates (
  id                 TEXT PRIMARY KEY,
  paypal_vault_id    TEXT NOT NULL,
  paypal_customer_id TEXT,
  status             TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at         INTEGER NOT NULL
);

-- Append-only trail of everything that happened. `details` is JSON and must never contain secrets.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  actor      TEXT NOT NULL,             -- 'agent:<id>', 'owner', 'reviewer', 'system'
  action     TEXT NOT NULL,             -- e.g. 'request.created', 'owner.approved', 'payment.captured'
  request_id TEXT,
  agent_id   TEXT,
  details    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_ts      ON audit_log(ts);
CREATE INDEX audit_request ON audit_log(request_id);
