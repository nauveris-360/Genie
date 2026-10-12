-- After rollback every approval is checked as v1. v2 digests then no longer
-- match, so pending v2 approvals fail closed (409 approval_payload_mismatch)
-- rather than being accepted without their agent binding.
ALTER TABLE approvals DROP COLUMN IF EXISTS digest_version;
