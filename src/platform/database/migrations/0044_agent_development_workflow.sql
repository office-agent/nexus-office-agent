BEGIN;

INSERT INTO permissions(id,code,description,risk_level) VALUES
  ('54400000-0000-4000-8000-000000000001','agent_development:read','Read Agent development workflow archives and progress',1),
  ('54400000-0000-4000-8000-000000000002','agent_development:write','Archive requirements, major versions and functional tests',2),
  ('54400000-0000-4000-8000-000000000003','agent_development:deliver','Freeze Agent development delivery manifests',3)
ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description,risk_level=EXCLUDED.risk_level;

CREATE TABLE agent_development_projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z][A-Za-z0-9._-]{1,39}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  owner_name text NOT NULL CHECK (char_length(owner_name) BETWEEN 2 AND 80),
  objective text NOT NULL,
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='array' AND jsonb_array_length(scope)>0),
  non_goals jsonb NOT NULL CHECK (jsonb_typeof(non_goals)='array'),
  acceptance_criteria jsonb NOT NULL CHECK (jsonb_typeof(acceptance_criteria)='array' AND jsonb_array_length(acceptance_criteria)>0),
  status text NOT NULL CHECK (status IN ('requirements_archived','in_development','testing','ready_to_deliver','delivered')),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK (version > 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE agent_development_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES agent_development_projects(id),
  kind text NOT NULL CHECK (kind IN ('overview','progress','features','versions','acceptance')),
  path text NOT NULL CHECK (path IN ('.project-to-act/PROJECT_OVERVIEW.md','.project-to-act/PROJECT_PROGRESS.md','.project-to-act/PROJECT_FEATURES.md','.project-to-act/PROJECT_VERSIONS.md','.project-to-act/PROJECT_ACCEPTANCE.md')),
  revision integer NOT NULL CHECK (revision > 0),
  content text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  archived_at timestamptz NOT NULL,
  UNIQUE (tenant_id, project_id, kind, revision)
);

CREATE TABLE agent_development_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES agent_development_projects(id),
  name text NOT NULL,
  from_commit text NOT NULL CHECK (from_commit ~ '^[a-f0-9]{7,64}$'),
  to_commit text NOT NULL CHECK (to_commit ~ '^[a-f0-9]{7,64}$'),
  diff_content text NOT NULL CHECK (char_length(diff_content) BETWEEN 1 AND 200000),
  diff_digest text NOT NULL CHECK (diff_digest ~ '^[a-f0-9]{64}$'),
  features jsonb NOT NULL CHECK (jsonb_typeof(features)='array' AND jsonb_array_length(features)>0),
  created_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, project_id, name),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE agent_development_tests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES agent_development_projects(id),
  version_id uuid NOT NULL REFERENCES agent_development_versions(id),
  name text NOT NULL,
  cases jsonb NOT NULL CHECK (jsonb_typeof(cases)='array' AND jsonb_array_length(cases)>0),
  result text NOT NULL CHECK (result IN ('passed','failed')),
  evidence text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE agent_development_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES agent_development_projects(id),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  document_digests jsonb NOT NULL CHECK (jsonb_typeof(document_digests)='object'),
  version_ids jsonb NOT NULL CHECK (jsonb_typeof(version_ids)='array' AND jsonb_array_length(version_ids)>0),
  test_ids jsonb NOT NULL CHECK (jsonb_typeof(test_ids)='array' AND jsonb_array_length(test_ids)>0),
  created_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, project_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_agent_development_projects_scope ON agent_development_projects(tenant_id,updated_at DESC);
CREATE INDEX idx_agent_development_documents_latest ON agent_development_documents(tenant_id,project_id,kind,revision DESC);
CREATE INDEX idx_agent_development_versions_project ON agent_development_versions(tenant_id,project_id,created_at);
CREATE INDEX idx_agent_development_tests_project ON agent_development_tests(tenant_id,project_id,version_id,created_at);

ALTER TABLE agent_development_projects ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_development_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_development_documents ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_development_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_development_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_development_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_development_tests ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_development_tests FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_development_deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_development_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_development_projects_tenant ON agent_development_projects USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agent_development_documents_tenant ON agent_development_documents USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agent_development_versions_tenant ON agent_development_versions USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agent_development_tests_tenant ON agent_development_tests USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agent_development_deliveries_tenant ON agent_development_deliveries USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON agent_development_projects FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON agent_development_documents FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON agent_development_versions FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON agent_development_tests FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON agent_development_deliveries FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
