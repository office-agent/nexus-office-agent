BEGIN;

ALTER TABLE work_task_events DROP CONSTRAINT work_task_events_event_type_check;
ALTER TABLE work_task_events ADD CONSTRAINT work_task_events_event_type_check CHECK (event_type IN (
  'mission_published','package_published','package_claimed','package_status_changed',
  'package_handoff_initiated','package_handoff_accepted','package_handoff_rejected'
));

CREATE TABLE work_task_handoffs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  package_id uuid NOT NULL REFERENCES work_packages(id),
  mission_id uuid NOT NULL REFERENCES work_missions(id),
  from_assignee_id uuid NOT NULL REFERENCES users(id),
  to_assignee_id uuid NOT NULL REFERENCES users(id),
  initiated_by uuid NOT NULL REFERENCES users(id),
  note text NOT NULL CHECK (length(btrim(note)) > 0),
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_refs)='array'),
  package_snapshot jsonb NOT NULL CHECK (jsonb_typeof(package_snapshot)='object'),
  source text NOT NULL CHECK (source IN ('human','agent')),
  source_run_id uuid REFERENCES agent_runs(id),
  status text NOT NULL CHECK (status IN ('pending','accepted','rejected')),
  response_note text,
  responded_by uuid REFERENCES users(id),
  response_run_id uuid REFERENCES agent_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (from_assignee_id <> to_assignee_id),
  CHECK ((status='pending' AND response_note IS NULL AND responded_by IS NULL AND response_run_id IS NULL AND responded_at IS NULL) OR (status IN ('accepted','rejected') AND responded_by IS NOT NULL AND responded_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR length(btrim(response_note)) > 0)
);

CREATE UNIQUE INDEX ux_work_task_handoffs_source_run
  ON work_task_handoffs(tenant_id,source_run_id) WHERE source_run_id IS NOT NULL;
CREATE UNIQUE INDEX ux_work_task_handoffs_response_run
  ON work_task_handoffs(tenant_id,response_run_id) WHERE response_run_id IS NOT NULL;
CREATE UNIQUE INDEX ux_work_task_handoffs_pending_package
  ON work_task_handoffs(tenant_id,package_id) WHERE status='pending';
CREATE INDEX idx_work_task_handoffs_package_chain
  ON work_task_handoffs(tenant_id,package_id,created_at,id);
CREATE INDEX idx_work_task_handoffs_recipient
  ON work_task_handoffs(tenant_id,to_assignee_id,status,created_at DESC);

ALTER TABLE work_task_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_task_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY work_task_handoffs_tenant_select_policy ON work_task_handoffs FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY work_task_handoffs_tenant_insert_policy ON work_task_handoffs FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY work_task_handoffs_tenant_update_policy ON work_task_handoffs FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON work_task_handoffs
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
