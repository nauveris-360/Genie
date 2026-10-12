-- After a transaction that ran set_config('app.current_tenant_id', ..., true)
-- commits, PostgreSQL leaves the setting defined at session level with the
-- empty string '' rather than removing it. The original policies cast that
-- straight to uuid, so the next *unscoped* query on the same pooled connection
-- failed with "invalid input syntax for type uuid" instead of simply seeing
-- zero rows. NULLIF(..., '') restores the intended default-deny behaviour on
-- every connection state. Applied migrations are never edited, hence 004.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['websites','provider_connections','agents','model_policies','tasks','approvals','audit_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
