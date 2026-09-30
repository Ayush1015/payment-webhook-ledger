CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  body_hash CHAR(64) NOT NULL,
  payment_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('captured', 'failed', 'refunded')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_payment_latest ON webhook_events(payment_id, occurred_at DESC, event_id DESC);
-- Independent merchant-side expected state. No endpoint accepts public ledger writes.
CREATE TABLE IF NOT EXISTS payments (
  payment_id TEXT PRIMARY KEY,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('captured', 'failed', 'refunded')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  cutoff TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  compared_count INTEGER NOT NULL CHECK (compared_count >= 0),
  mismatch_count INTEGER NOT NULL CHECK (mismatch_count >= 0)
);
CREATE TABLE IF NOT EXISTS reconciliation_findings (
  run_id UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL,
  reasons TEXT[] NOT NULL,
  expected JSONB,
  actual JSONB,
  PRIMARY KEY (run_id, payment_id)
);
