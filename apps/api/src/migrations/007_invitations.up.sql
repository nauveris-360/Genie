-- One-time invitations to join a tenant. Like memberships, this table is not
-- under row-level security: accepting looks an invitation up by its token
-- before the tenant is known. Every tenant-facing query on it filters by
-- tenant_id explicitly, and only a SHA-256 hash of each token is stored.
CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  invited_by UUID NOT NULL REFERENCES users (id),
  accepted_by UUID REFERENCES users (id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
-- At most one pending invitation per email per tenant.
CREATE UNIQUE INDEX invitations_one_pending_key ON invitations (tenant_id, email_normalized) WHERE status = 'pending';
CREATE INDEX invitations_tenant_created_idx ON invitations (tenant_id, created_at DESC);
