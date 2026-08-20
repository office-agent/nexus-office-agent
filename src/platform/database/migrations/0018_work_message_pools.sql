BEGIN;

ALTER TABLE work_packages ADD COLUMN target_org_unit_id uuid REFERENCES org_units(id);
ALTER TABLE work_packages ADD CONSTRAINT work_packages_direct_target_check
  CHECK (assignment_mode <> 'direct' OR target_org_unit_id IS NULL);
CREATE INDEX idx_work_packages_department_claim
  ON work_packages(tenant_id,target_org_unit_id,status,due_at)
  WHERE assignment_mode='open_claim' AND assignee_id IS NULL AND target_org_unit_id IS NOT NULL;

CREATE TABLE work_pool_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pool_scope text NOT NULL CHECK (pool_scope IN ('company','department')),
  org_unit_id uuid REFERENCES org_units(id),
  subject text NOT NULL CHECK (length(btrim(subject)) > 0),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  author_id uuid NOT NULL REFERENCES users(id),
  source text NOT NULL CHECK (source IN ('human','agent')),
  source_run_id uuid REFERENCES agent_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((pool_scope='company' AND org_unit_id IS NULL) OR (pool_scope='department' AND org_unit_id IS NOT NULL))
);

CREATE UNIQUE INDEX ux_work_pool_messages_source_run
  ON work_pool_messages(tenant_id,source_run_id) WHERE source_run_id IS NOT NULL;
CREATE INDEX idx_work_pool_messages_pool
  ON work_pool_messages(tenant_id,pool_scope,org_unit_id,created_at DESC,id DESC);

CREATE TABLE work_pool_feedback (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  message_id uuid NOT NULL REFERENCES work_pool_messages(id),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_work_pool_feedback_message ON work_pool_feedback(tenant_id,message_id,created_at,id);

CREATE TABLE work_message_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pool_scope text NOT NULL CHECK (pool_scope IN ('company','department')),
  org_unit_id uuid REFERENCES org_units(id),
  message_id uuid NOT NULL REFERENCES work_pool_messages(id),
  event_type text NOT NULL CHECK (event_type IN ('message_published','feedback_published')),
  actor_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((pool_scope='company' AND org_unit_id IS NULL) OR (pool_scope='department' AND org_unit_id IS NOT NULL))
);

CREATE INDEX idx_work_message_events_stream ON work_message_events(tenant_id,sequence);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['work_pool_messages','work_pool_feedback','work_message_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_select_policy', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_insert_policy', table_name);
    EXECUTE format('CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change()', table_name);
  END LOOP;
END;
$$;

COMMIT;
