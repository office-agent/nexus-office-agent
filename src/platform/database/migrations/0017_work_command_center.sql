BEGIN;

CREATE TABLE work_conversations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  status text NOT NULL CHECK (status IN ('active','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_work_conversations_active_owner ON work_conversations(tenant_id,owner_id) WHERE status='active';

CREATE TABLE work_conversation_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES work_conversations(id),
  role text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content text NOT NULL CHECK (length(btrim(content)) > 0),
  run_id uuid REFERENCES agent_runs(id),
  route jsonb NOT NULL DEFAULT '{"skills":[],"tools":[]}'::jsonb CHECK (jsonb_typeof(route)='object'),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations)='array'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_work_messages_run_role ON work_conversation_messages(tenant_id,run_id,role) WHERE run_id IS NOT NULL;
CREATE INDEX idx_work_messages_conversation ON work_conversation_messages(tenant_id,conversation_id,created_at,id);

CREATE TABLE work_missions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES work_conversations(id),
  project_id uuid REFERENCES projects(id),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  objective text NOT NULL CHECK (length(btrim(objective)) > 0),
  priority text NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  due_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active','completed','cancelled')),
  published_by uuid NOT NULL REFERENCES users(id),
  source text NOT NULL CHECK (source IN ('human','agent')),
  source_run_id uuid REFERENCES agent_runs(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_at > created_at)
);

CREATE UNIQUE INDEX ux_work_missions_source_run ON work_missions(tenant_id,source_run_id) WHERE source_run_id IS NOT NULL;
CREATE INDEX idx_work_missions_owner ON work_missions(tenant_id,published_by,status,updated_at DESC);

CREATE TABLE work_packages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  mission_id uuid NOT NULL REFERENCES work_missions(id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text NOT NULL,
  acceptance_criteria text NOT NULL CHECK (length(btrim(acceptance_criteria)) > 0),
  required_skills jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_skills)='array'),
  assignment_mode text NOT NULL CHECK (assignment_mode IN ('direct','open_claim')),
  assignee_id uuid REFERENCES users(id),
  published_by uuid NOT NULL REFERENCES users(id),
  priority text NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  due_at timestamptz NOT NULL,
  capacity_points integer NOT NULL CHECK (capacity_points BETWEEN 1 AND 40),
  status text NOT NULL CHECK (status IN ('published','assigned','claimed','in_progress','blocked','in_review','completed','cancelled')),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs)='array'),
  blocked_reason text,
  claimed_at timestamptz,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,mission_id,ordinal),
  CHECK ((assignment_mode='direct' AND assignee_id IS NOT NULL AND status<>'published') OR assignment_mode<>'direct'),
  CHECK ((assignment_mode='open_claim' AND status='published' AND assignee_id IS NULL) OR status<>'published'),
  CHECK (status<>'blocked' OR length(btrim(blocked_reason)) > 0),
  CHECK (status<>'completed' OR (completed_at IS NOT NULL AND jsonb_array_length(evidence_refs)>0)),
  CHECK (due_at > created_at)
);

CREATE INDEX idx_work_packages_my_tasks ON work_packages(tenant_id,assignee_id,status,due_at);
CREATE INDEX idx_work_packages_open_claim ON work_packages(tenant_id,status,due_at) WHERE assignment_mode='open_claim' AND assignee_id IS NULL;
CREATE INDEX idx_work_packages_publisher ON work_packages(tenant_id,published_by,updated_at DESC);

CREATE TABLE work_task_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  mission_id uuid NOT NULL REFERENCES work_missions(id),
  package_id uuid REFERENCES work_packages(id),
  event_type text NOT NULL CHECK (event_type IN ('mission_published','package_published','package_claimed','package_status_changed')),
  actor_id uuid NOT NULL REFERENCES users(id),
  audience text NOT NULL CHECK (audience IN ('tenant','participants')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_work_task_events_stream ON work_task_events(tenant_id,sequence);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['work_conversations','work_conversation_messages','work_missions','work_packages','work_task_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_select_policy', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_insert_policy', table_name);
  END LOOP;
END;
$$;

CREATE POLICY work_conversations_tenant_update_policy ON work_conversations FOR UPDATE USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY work_missions_tenant_update_policy ON work_missions FOR UPDATE USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY work_packages_tenant_update_policy ON work_packages FOR UPDATE USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON work_conversations FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON work_conversation_messages FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON work_missions FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON work_packages FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT ON work_task_events FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
