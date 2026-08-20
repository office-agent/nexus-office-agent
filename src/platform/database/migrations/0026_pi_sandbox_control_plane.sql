BEGIN;

ALTER TABLE sandbox_runs
  ADD COLUMN IF NOT EXISTS actor_id uuid,
  ADD COLUMN IF NOT EXISTS pi_run_id uuid,
  ADD COLUMN IF NOT EXISTS workspace_id text,
  ADD COLUMN IF NOT EXISTS profile text,
  ADD COLUMN IF NOT EXISTS provider_sandbox_id text,
  ADD COLUMN IF NOT EXISTS network_policy_digest text,
  ADD COLUMN IF NOT EXISTS network_policy_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resource_limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS usage jsonb,
  ADD COLUMN IF NOT EXISTS destroy_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS termination_reason text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE sandbox_runs AS runs
SET actor_id = sessions.actor_id,
    workspace_id = COALESCE(runs.workspace_id, sessions.workspace_id),
    profile = COALESCE(runs.profile, sessions.profile),
    network_policy_digest = COALESCE(runs.network_policy_digest, repeat('0', 64)),
    resource_limits = CASE WHEN runs.resource_quota = '{}'::jsonb THEN '{}'::jsonb ELSE runs.resource_quota END
FROM pi_sessions AS sessions
WHERE sessions.tenant_id = runs.tenant_id
  AND sessions.id = runs.pi_session_id
  AND runs.actor_id IS NULL;

ALTER TABLE sandbox_runs ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE sandbox_runs ALTER COLUMN workspace_id SET DEFAULT 'unknown';
ALTER TABLE sandbox_runs ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE sandbox_runs ALTER COLUMN profile SET DEFAULT 'unknown';
ALTER TABLE sandbox_runs ALTER COLUMN profile SET NOT NULL;
ALTER TABLE sandbox_runs ALTER COLUMN network_policy_digest SET DEFAULT repeat('0', 64);
ALTER TABLE sandbox_runs ALTER COLUMN network_policy_digest SET NOT NULL;

ALTER TABLE sandbox_runs DROP CONSTRAINT IF EXISTS sandbox_runs_status_check;
ALTER TABLE sandbox_runs ADD CONSTRAINT sandbox_runs_status_check CHECK (
  status IN ('provisioning','running','terminating','completed','failed','destroyed','unknown')
);
ALTER TABLE sandbox_runs DROP CONSTRAINT IF EXISTS sandbox_runs_actor_id_fkey;
ALTER TABLE sandbox_runs ADD CONSTRAINT sandbox_runs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);
ALTER TABLE sandbox_runs DROP CONSTRAINT IF EXISTS sandbox_runs_pi_run_id_fkey;
ALTER TABLE sandbox_runs ADD CONSTRAINT sandbox_runs_pi_run_id_fkey FOREIGN KEY (pi_run_id) REFERENCES pi_run_manifests(run_id);
ALTER TABLE sandbox_runs DROP CONSTRAINT IF EXISTS sandbox_runs_network_policy_digest_check;
ALTER TABLE sandbox_runs ADD CONSTRAINT sandbox_runs_network_policy_digest_check CHECK (network_policy_digest ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS uq_sandbox_runs_tenant_pi_run
  ON sandbox_runs(tenant_id, pi_run_id)
  WHERE pi_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_session
  ON sandbox_runs(tenant_id, pi_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_cleanup
  ON sandbox_runs(tenant_id, status, updated_at)
  WHERE status <> 'destroyed';

COMMIT;
