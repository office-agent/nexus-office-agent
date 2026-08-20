BEGIN;

ALTER TABLE agent_tool_jobs DROP CONSTRAINT agent_tool_jobs_status_check;
ALTER TABLE agent_tool_jobs ADD CONSTRAINT agent_tool_jobs_status_check
  CHECK (status IN ('queued','executing','retry_scheduled','succeeded','failed','unknown','dead_letter','cancelled','compensated'));

CREATE TABLE agent_job_resolutions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_tool_job_id uuid NOT NULL REFERENCES agent_tool_jobs(id),
  request_id uuid NOT NULL,
  resolved_by uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('cancel','retry','mark_succeeded','mark_failed','record_compensated')),
  previous_status text NOT NULL,
  next_status text NOT NULL,
  reason text NOT NULL,
  evidence_digest text,
  evidence_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_tool_job_id, request_id),
  CHECK (action = 'cancel' OR evidence_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_agent_job_resolutions_job
  ON agent_job_resolutions(tenant_id, agent_tool_job_id, created_at DESC);

ALTER TABLE agent_job_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_job_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_job_resolutions_tenant_select_policy ON agent_job_resolutions FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY agent_job_resolutions_tenant_insert_policy ON agent_job_resolutions FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON agent_job_resolutions
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
