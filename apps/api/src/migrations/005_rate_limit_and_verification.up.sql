-- 1. Fixed-window counters for login rate limiting. Database-backed so limits
--    hold across API restarts and multiple instances without a cache service.
CREATE TABLE rate_limit_buckets (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX rate_limit_buckets_window_start_idx ON rate_limit_buckets (window_start);

-- 2. Model pricing provenance. A row only counts as "verified free" when a
--    trusted verification job wrote it; seeded placeholder rows are 'seed' and
--    fail closed regardless of their pricing_status. No API endpoint can flip
--    this column; only the (not yet implemented) verification job may.
ALTER TABLE models
  ADD COLUMN verification_source TEXT NOT NULL DEFAULT 'seed'
  CHECK (verification_source IN ('seed', 'trusted'));

-- The seed previously stamped last_verified_at = now(), which misrepresented a
-- placeholder as a verification. Clear it.
UPDATE models SET last_verified_at = NULL WHERE verification_source = 'seed';
