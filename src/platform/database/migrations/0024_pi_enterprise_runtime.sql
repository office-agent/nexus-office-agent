BEGIN;

CREATE TABLE agent_profiles (
  id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version integer NOT NULL CHECK (version > 0),
  description text NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('draft','approved','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id, version)
);

CREATE TABLE skill_releases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  skill_id text NOT NULL,
  version text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global','tenant','project','personal')),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  required_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_classification text NOT NULL CHECK (data_classification IN ('public','internal','confidential','restricted')),
  risk_level text NOT NULL CHECK (risk_level IN ('R0','R1','R2','R3','R4')),
  allowed_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_status text NOT NULL CHECK (approval_status IN ('pending','approved','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, skill_id, version)
);

CREATE TABLE mcp_servers (
  id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  source text NOT NULL,
  endpoint_ref text NOT NULL,
  network_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_status text NOT NULL CHECK (approval_status IN ('pending','approved','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id, version)
);

CREATE TABLE mcp_tool_bindings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  server_id text NOT NULL,
  server_version text NOT NULL,
  tool_name text NOT NULL,
  exposed_name text NOT NULL,
  input_schema jsonb NOT NULL,
  required_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_level text NOT NULL CHECK (risk_level IN ('R0','R1','R2','R3','R4')),
  status text NOT NULL CHECK (status IN ('approved','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, exposed_name),
  FOREIGN KEY (tenant_id, server_id, server_version) REFERENCES mcp_servers(tenant_id, id, version)
);

CREATE TABLE workspace_repositories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id text NOT NULL,
  forge_type text NOT NULL CHECK (forge_type IN ('forgejo','github','gitlab','other')),
  repository_ref text NOT NULL,
  default_branch text NOT NULL,
  credential_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, repository_ref)
);

CREATE TABLE pi_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  workspace_id text NOT NULL,
  repository_id uuid,
  base_commit text CHECK (base_commit IS NULL OR base_commit ~ '^[a-f0-9]{7,64}$'),
  profile text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  status text NOT NULL CHECK (status IN ('created','running','awaiting_approval','succeeded','failed','cancelled','unknown')),
  model_policy text NOT NULL,
  sandbox_profile text NOT NULL,
  network_policy text NOT NULL CHECK (network_policy IN ('none','allowlist','restricted')),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  skill_digests jsonb NOT NULL DEFAULT '[]'::jsonb,
  mcp_server_digests jsonb NOT NULL DEFAULT '[]'::jsonb,
  sandbox_run_id uuid NOT NULL,
  trace_id text NOT NULL,
  last_event_sequence integer NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pi_session_branches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  parent_branch_id uuid REFERENCES pi_session_branches(id),
  base_event_sequence integer NOT NULL DEFAULT 0 CHECK (base_event_sequence >= 0),
  label text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pi_session_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, pi_session_id, sequence)
);

CREATE TABLE pi_tool_calls (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  input_digest text NOT NULL,
  policy_version integer NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('R0','R1','R2','R3','R4')),
  status text NOT NULL CHECK (status IN ('planned','policy_checked','awaiting_approval','executing','succeeded','failed','cancelled')),
  output_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, pi_session_id, tool_call_id)
);

CREATE TABLE pi_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  tool_call_id uuid REFERENCES pi_tool_calls(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  risk_level text NOT NULL CHECK (risk_level IN ('R0','R1','R2','R3','R4')),
  preview text NOT NULL,
  input_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','expired','revoked')),
  expires_at timestamptz NOT NULL,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sandbox_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  provider text NOT NULL CHECK (provider IN ('virtual','firecracker','kata','unavailable')),
  image_digest text,
  network_policy text NOT NULL CHECK (network_policy IN ('none','allowlist','restricted')),
  status text NOT NULL CHECK (status IN ('provisioning','running','completed','failed','destroyed')),
  resource_quota jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pi_checkpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  label text NOT NULL,
  git_commit_sha text,
  diff_digest text NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_artifacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  artifact_type text NOT NULL CHECK (artifact_type IN ('diff','test_report','scan_report','build','patch','log')),
  storage_ref text NOT NULL,
  content_digest text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pi_sessions_actor ON pi_sessions(tenant_id, actor_id, created_at DESC);
CREATE INDEX idx_pi_session_events_cursor ON pi_session_events(tenant_id, pi_session_id, sequence);
CREATE INDEX idx_pi_tool_calls_session ON pi_tool_calls(tenant_id, pi_session_id, created_at DESC);
CREATE INDEX idx_pi_checkpoints_session ON pi_checkpoints(tenant_id, pi_session_id, created_at DESC);

ALTER TABLE agent_profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_releases ENABLE ROW LEVEL SECURITY; ALTER TABLE skill_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY; ALTER TABLE mcp_servers FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_bindings ENABLE ROW LEVEL SECURITY; ALTER TABLE mcp_tool_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_repositories ENABLE ROW LEVEL SECURITY; ALTER TABLE workspace_repositories FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE pi_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_session_branches ENABLE ROW LEVEL SECURITY; ALTER TABLE pi_session_branches FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_session_events ENABLE ROW LEVEL SECURITY; ALTER TABLE pi_session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_tool_calls ENABLE ROW LEVEL SECURITY; ALTER TABLE pi_tool_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_approvals ENABLE ROW LEVEL SECURITY; ALTER TABLE pi_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE sandbox_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_checkpoints ENABLE ROW LEVEL SECURITY; ALTER TABLE pi_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_artifacts ENABLE ROW LEVEL SECURITY; ALTER TABLE workspace_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_profiles_tenant_policy ON agent_profiles USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY skill_releases_tenant_policy ON skill_releases USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY mcp_servers_tenant_policy ON mcp_servers USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY mcp_tool_bindings_tenant_policy ON mcp_tool_bindings USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY workspace_repositories_tenant_policy ON workspace_repositories USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_sessions_tenant_policy ON pi_sessions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_session_branches_tenant_policy ON pi_session_branches USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_session_events_tenant_policy ON pi_session_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_tool_calls_tenant_policy ON pi_tool_calls USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_approvals_tenant_policy ON pi_approvals USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY sandbox_runs_tenant_policy ON sandbox_runs USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_checkpoints_tenant_policy ON pi_checkpoints USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY workspace_artifacts_tenant_policy ON workspace_artifacts USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON agent_profiles FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON skill_releases FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON mcp_servers FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON mcp_tool_bindings FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON workspace_repositories FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_sessions FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_session_branches FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_session_events FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_tool_calls FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_approvals FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON sandbox_runs FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_checkpoints FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON workspace_artifacts FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
