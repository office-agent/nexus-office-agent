BEGIN;

DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_run_commands;
DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_run_manifests;
DROP POLICY IF EXISTS pi_run_commands_tenant_policy ON pi_run_commands;
DROP POLICY IF EXISTS pi_run_manifests_tenant_policy ON pi_run_manifests;
DROP TABLE IF EXISTS pi_run_commands;
DROP TABLE IF EXISTS pi_run_manifests;

ALTER TABLE worker_heartbeats DROP CONSTRAINT IF EXISTS worker_heartbeats_role_check;
ALTER TABLE worker_heartbeats ADD CONSTRAINT worker_heartbeats_role_check CHECK (
  role IN ('inbox','agent','outbox')
);

ALTER TABLE pi_sessions DROP CONSTRAINT IF EXISTS pi_sessions_status_check;
ALTER TABLE pi_sessions ADD CONSTRAINT pi_sessions_status_check CHECK (
  status IN ('created','running','awaiting_approval','succeeded','failed','cancelled','unknown')
);

COMMIT;
