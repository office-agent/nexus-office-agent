BEGIN;

ALTER TABLE workspace_repositories
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE pi_sessions
  ADD COLUMN IF NOT EXISTS base_ref text NOT NULL DEFAULT 'HEAD';

ALTER TABLE pi_checkpoints
  ADD COLUMN IF NOT EXISTS pi_workspace_id uuid,
  ADD COLUMN IF NOT EXISTS pi_run_id uuid;

CREATE TABLE pi_workspaces (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  pi_run_id uuid NOT NULL REFERENCES pi_run_manifests(run_id),
  workspace_id text NOT NULL,
  repository_id uuid NOT NULL REFERENCES workspace_repositories(id),
  provider text NOT NULL CHECK (provider IN ('forgejo','github','gitlab','other')),
  repository_ref text NOT NULL,
  base_ref text NOT NULL,
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40,64}$'),
  ephemeral_branch text NOT NULL CHECK (ephemeral_branch ~ '^pi/[A-Za-z0-9._/-]+$'),
  status text NOT NULL CHECK (status IN ('preparing','ready','checkpointing','destroying','destroyed','failed','unknown')),
  provider_workspace_ref text,
  head_commit_sha text CHECK (head_commit_sha IS NULL OR head_commit_sha ~ '^[a-f0-9]{40,64}$'),
  workspace_digest text CHECK (workspace_digest IS NULL OR workspace_digest ~ '^[a-f0-9]{64}$'),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  UNIQUE (tenant_id, pi_run_id),
  UNIQUE (tenant_id, id, repository_id)
);

CREATE TABLE pi_git_credential_leases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_workspace_id uuid NOT NULL REFERENCES pi_workspaces(id),
  repository_id uuid NOT NULL REFERENCES workspace_repositories(id),
  branch text NOT NULL CHECK (branch ~ '^pi/[A-Za-z0-9._/-]+$'),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  lease_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, lease_ref)
);

ALTER TABLE workspace_artifacts
  ADD COLUMN IF NOT EXISTS actor_id uuid,
  ADD COLUMN IF NOT EXISTS pi_run_id uuid,
  ADD COLUMN IF NOT EXISTS pi_workspace_id uuid,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS file_name text NOT NULL DEFAULT 'artifact',
  ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'application/octet-stream',
  ADD COLUMN IF NOT EXISTS object_version text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS size_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE workspace_artifacts AS artifacts
SET actor_id = sessions.actor_id
FROM pi_sessions AS sessions
WHERE sessions.tenant_id = artifacts.tenant_id
  AND sessions.id = artifacts.pi_session_id
  AND artifacts.actor_id IS NULL;

ALTER TABLE workspace_artifacts ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE workspace_artifacts DROP CONSTRAINT IF EXISTS workspace_artifacts_status_check;
ALTER TABLE workspace_artifacts ADD CONSTRAINT workspace_artifacts_status_check CHECK (status IN ('active','revoked','expired'));
ALTER TABLE workspace_artifacts DROP CONSTRAINT IF EXISTS workspace_artifacts_version_check;
ALTER TABLE workspace_artifacts ADD CONSTRAINT workspace_artifacts_version_check CHECK (version > 0);
ALTER TABLE workspace_artifacts DROP CONSTRAINT IF EXISTS workspace_artifacts_size_check;
ALTER TABLE workspace_artifacts ADD CONSTRAINT workspace_artifacts_size_check CHECK (size_bytes >= 0);
ALTER TABLE workspace_artifacts DROP CONSTRAINT IF EXISTS workspace_artifacts_actor_id_fkey;
ALTER TABLE workspace_artifacts ADD CONSTRAINT workspace_artifacts_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);
ALTER TABLE workspace_artifacts DROP CONSTRAINT IF EXISTS workspace_artifacts_pi_workspace_id_fkey;
ALTER TABLE workspace_artifacts ADD CONSTRAINT workspace_artifacts_pi_workspace_id_fkey FOREIGN KEY (pi_workspace_id) REFERENCES pi_workspaces(id);
ALTER TABLE workspace_artifacts DROP CONSTRAINT IF EXISTS workspace_artifacts_pi_run_id_fkey;
ALTER TABLE workspace_artifacts ADD CONSTRAINT workspace_artifacts_pi_run_id_fkey FOREIGN KEY (pi_run_id) REFERENCES pi_run_manifests(run_id);

ALTER TABLE pi_checkpoints DROP CONSTRAINT IF EXISTS pi_checkpoints_pi_workspace_id_fkey;
ALTER TABLE pi_checkpoints ADD CONSTRAINT pi_checkpoints_pi_workspace_id_fkey FOREIGN KEY (pi_workspace_id) REFERENCES pi_workspaces(id);
ALTER TABLE pi_checkpoints DROP CONSTRAINT IF EXISTS pi_checkpoints_pi_run_id_fkey;
ALTER TABLE pi_checkpoints ADD CONSTRAINT pi_checkpoints_pi_run_id_fkey FOREIGN KEY (pi_run_id) REFERENCES pi_run_manifests(run_id);

CREATE TABLE pi_download_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  artifact_id uuid NOT NULL REFERENCES workspace_artifacts(id),
  artifact_version integer NOT NULL CHECK (artifact_version > 0),
  grant_ref text NOT NULL,
  url text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, grant_ref)
);

CREATE INDEX idx_pi_workspaces_session ON pi_workspaces(tenant_id, pi_session_id, created_at DESC);
CREATE INDEX idx_pi_workspaces_cleanup ON pi_workspaces(tenant_id, status, updated_at) WHERE status <> 'destroyed';
CREATE INDEX idx_pi_git_credential_leases_cleanup ON pi_git_credential_leases(tenant_id, status, expires_at);
CREATE INDEX idx_workspace_artifacts_session ON workspace_artifacts(tenant_id, pi_session_id, created_at DESC);
CREATE INDEX idx_workspace_artifacts_retention ON workspace_artifacts(status, expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE INDEX idx_pi_download_grants_cleanup ON pi_download_grants(tenant_id, status, expires_at);

ALTER TABLE pi_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_git_credential_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_git_credential_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_download_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_download_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_workspaces_tenant_policy ON pi_workspaces
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_git_credential_leases_tenant_policy ON pi_git_credential_leases
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_download_grants_tenant_policy ON pi_download_grants
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_workspaces
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_git_credential_leases
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_download_grants
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
