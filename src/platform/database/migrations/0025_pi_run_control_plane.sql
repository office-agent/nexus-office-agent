BEGIN;

ALTER TABLE pi_sessions DROP CONSTRAINT IF EXISTS pi_sessions_status_check;
ALTER TABLE pi_sessions ADD CONSTRAINT pi_sessions_status_check CHECK (
  status IN ('created','queued','running','awaiting_approval','cancelling','succeeded','failed','timed_out','cancelled','unknown')
);

ALTER TABLE worker_heartbeats DROP CONSTRAINT IF EXISTS worker_heartbeats_role_check;
ALTER TABLE worker_heartbeats ADD CONSTRAINT worker_heartbeats_role_check CHECK (
  role IN ('inbox','agent','outbox','pi-runner')
);

CREATE TABLE pi_run_manifests (
  run_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  controller_signature text NOT NULL,
  prompt_digest text NOT NULL CHECK (prompt_digest ~ '^[a-f0-9]{64}$'),
  run_status text NOT NULL CHECK (run_status IN ('queued','provisioning','running','awaiting_approval','cancelling','completed','failed','cancelled','timed_out','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, manifest_digest)
);

CREATE TABLE pi_run_commands (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  run_id uuid NOT NULL REFERENCES pi_run_manifests(run_id),
  command_type text NOT NULL CHECK (command_type IN ('prompt','interrupt','cancel','checkpoint')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','queued','leased','acknowledged','cancel_requested','cancelled','unknown','dead_lettered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (lease_token IS NULL AND lease_owner IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > leased_at)
  )
);

CREATE INDEX idx_pi_run_commands_claimable
  ON pi_run_commands(tenant_id, available_at, created_at, id)
  WHERE status IN ('accepted','queued','leased');
CREATE INDEX idx_pi_run_commands_expired_lease
  ON pi_run_commands(tenant_id, lease_expires_at)
  WHERE status='leased';
CREATE INDEX idx_pi_run_commands_run
  ON pi_run_commands(tenant_id, run_id, created_at DESC);
CREATE INDEX idx_pi_run_manifests_session
  ON pi_run_manifests(tenant_id, pi_session_id, created_at DESC);

ALTER TABLE pi_run_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_run_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_run_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_run_commands FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_run_manifests_tenant_policy ON pi_run_manifests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_run_commands_tenant_policy ON pi_run_commands
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_run_manifests
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_run_commands
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
