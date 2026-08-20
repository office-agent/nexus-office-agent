BEGIN;

CREATE TABLE work_artifacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  current_version integer NOT NULL CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_work_artifacts_owner ON work_artifacts(tenant_id,owner_id,created_at DESC);

CREATE TABLE work_artifact_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  artifact_id uuid NOT NULL REFERENCES work_artifacts(id),
  version integer NOT NULL CHECK (version > 0),
  file_name text NOT NULL CHECK (length(btrim(file_name)) > 0),
  media_type text NOT NULL CHECK (length(btrim(media_type)) > 0),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  storage_ref text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,artifact_id,version)
);

CREATE INDEX idx_work_artifact_versions_lookup ON work_artifact_versions(tenant_id,artifact_id,version DESC);

ALTER TABLE work_task_handoffs
  ADD COLUMN artifact_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(artifact_snapshots)='array');

ALTER TABLE work_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY work_artifacts_tenant_select_policy ON work_artifacts FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY work_artifacts_tenant_insert_policy ON work_artifacts FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY work_artifacts_tenant_update_policy ON work_artifacts FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE work_artifact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_artifact_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY work_artifact_versions_tenant_select_policy ON work_artifact_versions FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY work_artifact_versions_tenant_insert_policy ON work_artifact_versions FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON work_artifacts
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON work_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
