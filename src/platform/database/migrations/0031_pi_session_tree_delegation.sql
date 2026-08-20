BEGIN;

ALTER TABLE pi_session_branches
  ADD COLUMN IF NOT EXISTS head_event_sequence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE pi_session_branches
SET head_event_sequence=GREATEST(head_event_sequence, base_event_sequence),
    status=COALESCE(status,'active'),
    idempotency_key=COALESCE(idempotency_key,'legacy:' || id::text);

ALTER TABLE pi_session_branches ALTER COLUMN status SET NOT NULL;
ALTER TABLE pi_session_branches ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE pi_session_branches DROP CONSTRAINT IF EXISTS pi_session_branches_status_check;
ALTER TABLE pi_session_branches ADD CONSTRAINT pi_session_branches_status_check CHECK (status IN ('active','archived'));
ALTER TABLE pi_session_branches DROP CONSTRAINT IF EXISTS pi_session_branches_sequence_check;
ALTER TABLE pi_session_branches ADD CONSTRAINT pi_session_branches_sequence_check CHECK (head_event_sequence >= base_event_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_session_branches_idempotency
  ON pi_session_branches(tenant_id, pi_session_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pi_session_branches_parent
  ON pi_session_branches(tenant_id, pi_session_id, parent_branch_id, created_at);

ALTER TABLE pi_session_events ADD COLUMN IF NOT EXISTS branch_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='pi_session_events_branch_fk'
  ) THEN
    ALTER TABLE pi_session_events ADD CONSTRAINT pi_session_events_branch_fk FOREIGN KEY (branch_id) REFERENCES pi_session_branches(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_pi_session_events_branch ON pi_session_events(tenant_id, pi_session_id, branch_id, sequence);

CREATE TABLE IF NOT EXISTS pi_context_summaries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  branch_id uuid NOT NULL REFERENCES pi_session_branches(id),
  source_start_sequence integer NOT NULL CHECK (source_start_sequence >= 1),
  source_end_sequence integer NOT NULL CHECK (source_end_sequence >= source_start_sequence),
  source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_digest text NOT NULL CHECK (summary_digest ~ '^[a-f0-9]{64}$'),
  compaction_version integer NOT NULL CHECK (compaction_version > 0),
  idempotency_key text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, pi_session_id, branch_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pi_agent_delegations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parent_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  parent_branch_id uuid REFERENCES pi_session_branches(id),
  child_session_id uuid REFERENCES pi_sessions(id),
  parent_run_id uuid,
  child_run_id uuid,
  profile_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[a-f0-9]{64}$'),
  depth integer NOT NULL CHECK (depth >= 1),
  status text NOT NULL CHECK (status IN ('proposed','admitted','queued','running','completed','failed','cancelled')),
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, parent_session_id, idempotency_key),
  UNIQUE (tenant_id, child_session_id)
);

CREATE INDEX IF NOT EXISTS idx_pi_agent_delegations_parent
  ON pi_agent_delegations(tenant_id, parent_session_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_agent_delegations_child
  ON pi_agent_delegations(tenant_id, child_session_id);

ALTER TABLE pi_context_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_context_summaries FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_agent_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_agent_delegations FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_context_summaries_tenant_policy ON pi_context_summaries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_agent_delegations_tenant_policy ON pi_agent_delegations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_context_summaries
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_agent_delegations
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
