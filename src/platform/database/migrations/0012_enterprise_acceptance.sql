BEGIN;

CREATE TABLE enterprise_acceptance_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_kind text NOT NULL CHECK (run_kind IN ('identity','connector')),
  subject_id text NOT NULL,
  provider text CHECK (provider IN ('feishu','dingtalk','wecom')),
  connection_id uuid REFERENCES connections(id),
  status text NOT NULL CHECK (status IN ('passed','failed','blocked')),
  step_results jsonb NOT NULL CHECK (jsonb_typeof(step_results) = 'array'),
  safe_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_evidence) = 'object'),
  initiated_by uuid NOT NULL REFERENCES users(id),
  trace_id text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_at >= started_at),
  CHECK (
    (run_kind = 'identity' AND provider IS NULL AND connection_id IS NULL)
    OR (run_kind = 'connector' AND provider IS NOT NULL AND connection_id IS NOT NULL)
  )
);

CREATE INDEX idx_acceptance_runs_latest
  ON enterprise_acceptance_runs(tenant_id,run_kind,subject_id,completed_at DESC);

ALTER TABLE enterprise_acceptance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_acceptance_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY enterprise_acceptance_runs_select_policy ON enterprise_acceptance_runs
  FOR SELECT USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY enterprise_acceptance_runs_insert_policy ON enterprise_acceptance_runs
  FOR INSERT WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Acceptance evidence is append-only: there is intentionally no UPDATE or DELETE policy.

CREATE TRIGGER nexus_atomic_audit AFTER INSERT ON enterprise_acceptance_runs
FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
