BEGIN;

ALTER TABLE pi_approvals
  ADD COLUMN IF NOT EXISTS pi_run_id uuid REFERENCES pi_run_manifests(run_id),
  ADD COLUMN IF NOT EXISTS tool_name text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS tool_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS expected_object_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS proposal_hash text,
  ADD COLUMN IF NOT EXISTS required_approver_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'single',
  ADD COLUMN IF NOT EXISTS required_approval_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS policy_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS superseded_by uuid,
  ADD COLUMN IF NOT EXISTS supersede_reason text,
  ADD COLUMN IF NOT EXISTS revalidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS revalidation_status text NOT NULL DEFAULT 'not_checked',
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE pi_approvals DROP CONSTRAINT IF EXISTS pi_approvals_status_check;
ALTER TABLE pi_approvals ADD CONSTRAINT pi_approvals_status_check CHECK (status IN ('pending','approved','rejected','expired','revoked','cancelled','superseded'));
ALTER TABLE pi_approvals DROP CONSTRAINT IF EXISTS pi_approvals_proposal_hash_check;
ALTER TABLE pi_approvals ADD CONSTRAINT pi_approvals_proposal_hash_check CHECK (proposal_hash IS NULL OR proposal_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE pi_approvals DROP CONSTRAINT IF EXISTS pi_approvals_tool_version_check;
ALTER TABLE pi_approvals ADD CONSTRAINT pi_approvals_tool_version_check CHECK (tool_version > 0);
ALTER TABLE pi_approvals DROP CONSTRAINT IF EXISTS pi_approvals_approval_mode_check;
ALTER TABLE pi_approvals ADD CONSTRAINT pi_approvals_approval_mode_check CHECK (approval_mode IN ('single','dual','all'));
ALTER TABLE pi_approvals DROP CONSTRAINT IF EXISTS pi_approvals_required_count_check;
ALTER TABLE pi_approvals ADD CONSTRAINT pi_approvals_required_count_check CHECK (required_approval_count > 0);
ALTER TABLE pi_approvals DROP CONSTRAINT IF EXISTS pi_approvals_policy_version_check;
ALTER TABLE pi_approvals ADD CONSTRAINT pi_approvals_policy_version_check CHECK (policy_version > 0);
ALTER TABLE pi_approvals DROP CONSTRAINT IF EXISTS pi_approvals_version_check;
ALTER TABLE pi_approvals ADD CONSTRAINT pi_approvals_version_check CHECK (version > 0);
ALTER TABLE pi_approvals DROP CONSTRAINT IF EXISTS pi_approvals_revalidation_status_check;
ALTER TABLE pi_approvals ADD CONSTRAINT pi_approvals_revalidation_status_check CHECK (revalidation_status IN ('not_checked','passed','failed'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_approvals_tenant_idempotency
  ON pi_approvals(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pi_approvals_actor_status
  ON pi_approvals(tenant_id, requested_by, status, created_at DESC);

CREATE TABLE IF NOT EXISTS pi_approval_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  approval_id uuid NOT NULL REFERENCES pi_approvals(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[a-f0-9]{64}$'),
  comment_digest text CHECK (comment_digest IS NULL OR comment_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, approval_id, actor_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pi_approval_decisions_approval
  ON pi_approval_decisions(tenant_id, approval_id, created_at, id);

ALTER TABLE pi_approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_approval_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_approval_decisions_tenant_policy ON pi_approval_decisions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;

