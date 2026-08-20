BEGIN;

DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_workspace_supervisor_states;
DROP POLICY IF EXISTS pi_workspace_supervisor_states_tenant_policy ON pi_workspace_supervisor_states;
DROP TABLE IF EXISTS pi_workspace_supervisor_states;

COMMIT;
