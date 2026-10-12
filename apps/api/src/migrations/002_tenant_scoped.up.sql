-- Tenant-scoped operational tables. Each carries tenant_id and is protected
-- by row-level security as a second, database-enforced layer of isolation
-- underneath the application-layer membership checks. The policy compares
-- tenant_id against the current_setting('app.current_tenant_id') that the
-- application sets with SET LOCAL at the start of every tenant-scoped
-- transaction; if that setting is absent, current_setting(..., true) returns
-- NULL and tenant_id = NULL is never true, so the default is deny-all, not
-- allow-all. FORCE ROW LEVEL SECURITY applies the policy even to the table
-- owner, so a bug that causes the pool to run as an owner/superuser role does
-- not silently disable isolation.

CREATE TABLE websites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')) DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX websites_tenant_id_idx ON websites (tenant_id);
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE websites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON websites
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE TABLE provider_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'gemini')),
  label TEXT NOT NULL,
  encrypted_credential BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX provider_connections_tenant_id_idx ON provider_connections (tenant_id);
ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON provider_connections
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')) DEFAULT 'active',
  provider_connection_id UUID NOT NULL REFERENCES provider_connections (id),
  model_id TEXT NOT NULL,
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agents_tenant_id_idx ON agents (tenant_id);
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Defense in depth: a provider_connection_id referenced by an agent must
-- belong to the same tenant as the agent. A plain foreign key cannot express
-- this (it would need a composite FK against a composite unique key), so a
-- trigger enforces it on insert/update. This exists in addition to, not
-- instead of, the application-layer check that loads the connection scoped
-- to the caller's tenant before using its id.
CREATE OR REPLACE FUNCTION assert_agent_provider_same_tenant() RETURNS TRIGGER AS $$
DECLARE
  connection_tenant_id UUID;
BEGIN
  SELECT tenant_id INTO connection_tenant_id
  FROM provider_connections
  WHERE id = NEW.provider_connection_id;

  IF connection_tenant_id IS NULL OR connection_tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'agent.provider_connection_id must belong to the same tenant as the agent';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_provider_same_tenant
  BEFORE INSERT OR UPDATE OF provider_connection_id, tenant_id ON agents
  FOR EACH ROW EXECUTE FUNCTION assert_agent_provider_same_tenant();

CREATE TABLE model_policies (
  tenant_id UUID PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  allow_paid_fallback BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users (id)
);

ALTER TABLE model_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON model_policies
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Global model registry (not tenant-scoped: pricing/availability facts are
-- the same for every tenant, only the policy applied to them differs).
CREATE TABLE models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'gemini')),
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  pricing_status TEXT NOT NULL CHECK (pricing_status IN ('verified_free', 'paid', 'unknown', 'stale')),
  input_price_per_million_tokens_usd NUMERIC,
  output_price_per_million_tokens_usd NUMERIC,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX models_provider_model_id_key ON models (provider, model_id);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  website_id UUID REFERENCES websites (id),
  agent_id UUID NOT NULL REFERENCES agents (id),
  type TEXT NOT NULL CHECK (type IN ('chat', 'summarize', 'embed', 'title_generate')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled')) DEFAULT 'queued',
  input JSONB NOT NULL,
  result JSONB,
  error TEXT,
  idempotency_key TEXT NOT NULL,
  request_payload_digest TEXT NOT NULL,
  approval_id UUID,
  external_ref TEXT,
  created_by UUID NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tasks_tenant_id_created_at_idx ON tasks (tenant_id, created_at DESC);
CREATE UNIQUE INDEX tasks_tenant_idempotency_key_key ON tasks (tenant_id, idempotency_key);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tasks
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks (id),
  action TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')) DEFAULT 'pending',
  decided_by UUID REFERENCES users (id),
  decided_at TIMESTAMPTZ,
  reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX approvals_tenant_id_created_at_idx ON approvals (tenant_id, created_at DESC);
CREATE INDEX approvals_task_id_idx ON approvals (task_id);
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approvals
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users (id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_id_created_at_idx ON audit_events (tenant_id, created_at DESC);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
