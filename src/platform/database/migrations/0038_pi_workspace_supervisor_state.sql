BEGIN;

CREATE TABLE pi_workspace_supervisor_states (
  state_id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  version bigint NOT NULL CHECK (version > 0),
  owner_id text,
  owner_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (state_id, tenant_id),
  CHECK ((owner_id IS NULL AND owner_expires_at IS NULL) OR (owner_id IS NOT NULL AND owner_expires_at IS NOT NULL))
);

CREATE INDEX idx_pi_workspace_supervisor_state_owner
  ON pi_workspace_supervisor_states(state_id, owner_expires_at);

ALTER TABLE pi_workspace_supervisor_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_workspace_supervisor_states FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_workspace_supervisor_states_tenant_policy ON pi_workspace_supervisor_states
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_workspace_supervisor_states
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
