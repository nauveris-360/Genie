-- Restores the 002 policy expressions exactly (including their '' -> uuid cast
-- defect) so that a rollback reproduces the previous schema faithfully.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['websites','provider_connections','agents','model_policies','tasks','approvals','audit_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid)
         WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid)', t);
  END LOOP;
END $$;
