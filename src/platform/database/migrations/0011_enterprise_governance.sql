BEGIN;

ALTER TABLE projects ADD COLUMN business_value text;
ALTER TABLE projects ADD COLUMN acceptance_criteria text;
ALTER TABLE projects ADD COLUMN resource_plan jsonb;
ALTER TABLE projects ADD COLUMN baseline_version integer NOT NULL DEFAULT 1 CHECK (baseline_version > 0);
UPDATE projects
   SET business_value=COALESCE(NULLIF(trim(description),''),'历史项目：业务价值待复核'),
       acceptance_criteria='历史项目：关闭前必须补充交付验收依据',
       resource_plan='{}'::jsonb
 WHERE business_value IS NULL OR acceptance_criteria IS NULL OR resource_plan IS NULL;
ALTER TABLE projects ALTER COLUMN business_value SET NOT NULL;
ALTER TABLE projects ALTER COLUMN acceptance_criteria SET NOT NULL;
ALTER TABLE projects ALTER COLUMN resource_plan SET NOT NULL;
ALTER TABLE projects ADD CONSTRAINT projects_business_value_required CHECK (length(trim(business_value)) > 0);
ALTER TABLE projects ADD CONSTRAINT projects_acceptance_required CHECK (length(trim(acceptance_criteria)) > 0);
ALTER TABLE projects ADD CONSTRAINT projects_resource_plan_object CHECK (jsonb_typeof(resource_plan) = 'object');

CREATE TABLE organization_change_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  change_type text NOT NULL CHECK (change_type IN ('transfer','departure')),
  effective_at timestamptz NOT NULL,
  from_org_unit_id uuid REFERENCES org_units(id),
  to_org_unit_id uuid REFERENCES org_units(id),
  successor_user_id uuid REFERENCES users(id),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  status text NOT NULL CHECK (status IN ('submitted','approved','completed','cancelled')),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  executed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (successor_user_id IS NULL OR successor_user_id <> subject_user_id),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (change_type <> 'transfer' OR to_org_unit_id IS NOT NULL),
  CHECK ((status IN ('approved','completed') AND approved_by IS NOT NULL) OR status IN ('submitted','cancelled')),
  CHECK ((status = 'completed' AND executed_at IS NOT NULL) OR status <> 'completed')
);

CREATE TABLE work_handoffs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_change_id uuid NOT NULL REFERENCES organization_change_cases(id),
  resource_type text NOT NULL CHECK (resource_type IN ('objective','project','task','risk','issue','action_item','approval','responsibility')),
  resource_id uuid NOT NULL,
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('transferred','accepted','failed')),
  evidence_ref text NOT NULL CHECK (length(trim(evidence_ref)) > 0),
  transferred_at timestamptz NOT NULL,
  accepted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, organization_change_id, resource_type, resource_id)
);

CREATE TABLE project_change_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  change_type text NOT NULL CHECK (change_type IN ('scope','schedule','budget','resource','quality')),
  baseline_before jsonb NOT NULL,
  proposed_baseline jsonb NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  impact_assessment text NOT NULL CHECK (length(trim(impact_assessment)) > 0),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('submitted','approved','rejected','applied','cancelled','compensated')),
  applied_project_version integer,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(baseline_before) = 'object' AND jsonb_typeof(proposed_baseline) = 'object'),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK ((status IN ('approved','applied','compensated') AND approved_by IS NOT NULL) OR status IN ('submitted','rejected','cancelled'))
);

CREATE TABLE project_closure_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  delivery_acceptance_ref text NOT NULL CHECK (length(trim(delivery_acceptance_ref)) > 0),
  unresolved_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrospective_ref text NOT NULL CHECK (length(trim(retrospective_ref)) > 0),
  owner_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('ready','approved','completed')),
  approved_by uuid REFERENCES users(id),
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(unresolved_items) = 'array'),
  CHECK ((status IN ('approved','completed') AND approved_by IS NOT NULL) OR status = 'ready'),
  CHECK ((status = 'completed' AND completed_at IS NOT NULL) OR status <> 'completed'),
  UNIQUE (tenant_id, project_id)
);

CREATE TABLE management_attention_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  source_type text NOT NULL CHECK (source_type IN ('milestone','task','risk','action_item','budget')),
  source_id text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('milestone_overdue','milestone_at_risk','critical_task_blocked','risk_exposure','action_overdue','budget_variance')),
  severity text NOT NULL CHECK (severity IN ('watch','at_risk','critical')),
  owner_id uuid NOT NULL REFERENCES users(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
  detected_at timestamptz NOT NULL,
  resolved_at timestamptz,
  dedupe_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE TABLE compensation_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_operation_type text NOT NULL CHECK (source_operation_type IN ('project_change')),
  source_operation_id uuid NOT NULL REFERENCES project_change_requests(id),
  resource_type text NOT NULL CHECK (resource_type IN ('project')),
  resource_id uuid NOT NULL,
  inverse_payload jsonb NOT NULL CHECK (jsonb_typeof(inverse_payload) = 'object'),
  expected_resource_version integer NOT NULL CHECK (expected_resource_version > 0),
  risk_level smallint NOT NULL CHECK (risk_level BETWEEN 0 AND 4),
  status text NOT NULL CHECK (status IN ('ready','executed','expired','failed')),
  expires_at timestamptz NOT NULL,
  executed_by uuid REFERENCES users(id),
  executed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'executed' AND executed_by IS NOT NULL AND executed_at IS NOT NULL) OR status <> 'executed'),
  UNIQUE (tenant_id, source_operation_type, source_operation_id)
);

CREATE INDEX idx_org_changes_subject ON organization_change_cases(tenant_id,subject_user_id,status,effective_at);
CREATE INDEX idx_work_handoffs_change ON work_handoffs(tenant_id,organization_change_id,status);
CREATE INDEX idx_project_changes_project ON project_change_requests(tenant_id,project_id,status,created_at DESC);
CREATE INDEX idx_project_closure_project ON project_closure_reviews(tenant_id,project_id,status);
CREATE INDEX idx_attention_open ON management_attention_items(tenant_id,status,severity,detected_at DESC);
CREATE INDEX idx_compensation_ready ON compensation_plans(tenant_id,status,expires_at);

ALTER TABLE organization_change_cases ENABLE ROW LEVEL SECURITY; ALTER TABLE organization_change_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE work_handoffs ENABLE ROW LEVEL SECURITY; ALTER TABLE work_handoffs FORCE ROW LEVEL SECURITY;
ALTER TABLE project_change_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE project_change_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE project_closure_reviews ENABLE ROW LEVEL SECURITY; ALTER TABLE project_closure_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE management_attention_items ENABLE ROW LEVEL SECURITY; ALTER TABLE management_attention_items FORCE ROW LEVEL SECURITY;
ALTER TABLE compensation_plans ENABLE ROW LEVEL SECURITY; ALTER TABLE compensation_plans FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_change_cases_tenant_policy ON organization_change_cases USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY work_handoffs_tenant_policy ON work_handoffs USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY project_change_requests_tenant_policy ON project_change_requests USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY project_closure_reviews_tenant_policy ON project_closure_reviews USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY management_attention_items_tenant_policy ON management_attention_items USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY compensation_plans_tenant_policy ON compensation_plans USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION nexus_project_completion_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='completed' AND OLD.status<>'completed' THEN
    IF NOT EXISTS (
      SELECT 1 FROM project_closure_reviews c
       WHERE c.tenant_id=NEW.tenant_id AND c.project_id=NEW.id AND c.status='approved'
    ) THEN RAISE EXCEPTION 'PROJECT_CLOSURE_REVIEW_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nexus_project_completion_gate BEFORE UPDATE OF status ON projects
FOR EACH ROW EXECUTE FUNCTION nexus_project_completion_gate();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['organization_change_cases','work_handoffs','project_change_requests','project_closure_reviews','management_attention_items','compensation_plans']
  LOOP
    EXECUTE format('CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change()',table_name);
  END LOOP;
END;
$$;

COMMIT;
