BEGIN;

ALTER TABLE pi_sessions
  ADD COLUMN IF NOT EXISTS resource_snapshot jsonb NOT NULL DEFAULT '{"schemaVersion":1,"skillDigests":[],"packageDigests":[],"extensionDigests":[],"policyVersion":1,"registryVersion":"registry-v1"}'::jsonb;

ALTER TABLE skill_releases
  ADD COLUMN IF NOT EXISTS content_ref text,
  ADD COLUMN IF NOT EXISTS content text,
  ADD COLUMN IF NOT EXISTS rollout_percent integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE skill_releases DROP CONSTRAINT IF EXISTS skill_releases_rollout_percent_check;
ALTER TABLE skill_releases ADD CONSTRAINT skill_releases_rollout_percent_check CHECK (rollout_percent BETWEEN 0 AND 100);

CREATE TABLE pi_resource_releases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  resource_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('package','extension')),
  version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  artifact_ref text NOT NULL,
  sbom_digest text NOT NULL CHECK (sbom_digest ~ '^[a-f0-9]{64}$'),
  scan_status text NOT NULL CHECK (scan_status IN ('not_required','pending','passed','failed')),
  approval_status text NOT NULL CHECK (approval_status IN ('pending','approved','revoked')),
  rollout_percent integer NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  allowed_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_classification text NOT NULL CHECK (data_classification IN ('public','internal','confidential','restricted')),
  risk_level text NOT NULL CHECK (risk_level IN ('R0','R1','R2','R3','R4')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (tenant_id, resource_id, resource_kind, version),
  UNIQUE (tenant_id, resource_kind, digest)
);

CREATE INDEX idx_skill_releases_resolve ON skill_releases(tenant_id, approval_status, skill_id, version);
CREATE INDEX idx_pi_resource_releases_resolve ON pi_resource_releases(tenant_id, resource_kind, approval_status, resource_id, version);

ALTER TABLE pi_resource_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_resource_releases FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_resource_releases_tenant_policy ON pi_resource_releases
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON pi_resource_releases
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
