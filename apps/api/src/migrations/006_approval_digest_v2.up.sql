-- Versioned approval digests. Every approval created before this migration
-- was bound with digest format v1 (task payload only) and keeps validating
-- as v1. The application creates new approvals as v2, which additionally
-- binds the agent's model, provider connection and config at request time,
-- so editing those after an approval was requested invalidates it.
ALTER TABLE approvals
  ADD COLUMN digest_version SMALLINT NOT NULL DEFAULT 1 CHECK (digest_version IN (1, 2));
