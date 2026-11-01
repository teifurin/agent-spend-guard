-- Migration 003 (DECISIONS D17): a refund PayPal answers PENDING is no longer booked as done.
-- The payment goes to REFUND_PENDING, keeps counting against the budget, and becomes REFUNDED only once PayPal
-- confirms it. SQLite cannot widen a CHECK constraint in place, so the table is rebuilt around its rows; no other
-- table references payments.
CREATE TABLE payments_v3 (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL UNIQUE REFERENCES requests(id),
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  paypal_order_id   TEXT,
  paypal_capture_id TEXT,
  paypal_refund_id  TEXT,
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('CREATED', 'COMPLETED', 'FAILED', 'REFUND_PENDING', 'REFUNDED')),
  captured_at       INTEGER,            -- set when status becomes COMPLETED; drives the monthly budget
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
INSERT INTO payments_v3 (id, request_id, agent_id, paypal_order_id, paypal_capture_id, paypal_refund_id, amount_minor, currency, status, captured_at, created_at, updated_at)
  SELECT id, request_id, agent_id, paypal_order_id, paypal_capture_id, paypal_refund_id, amount_minor, currency, status, captured_at, created_at, updated_at
  FROM payments;
DROP TABLE payments;
ALTER TABLE payments_v3 RENAME TO payments;
CREATE INDEX payments_agent_captured ON payments(agent_id, status, captured_at);
