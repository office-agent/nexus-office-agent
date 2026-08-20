BEGIN;

CREATE TABLE IF NOT EXISTS pi_release_candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  version text NOT NULL CHECK (version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$'),
  image_digest text NOT NULL CHECK (image_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  signature_digest text NOT NULL CHECK (signature_digest ~ '^[0-9a-f]{64}$'),
  sbom_digest text CHECK (sbom_digest IS NULL OR sbom_digest ~ '^[0-9a-f]{64}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('candidate','staged','active','rolled_back')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  rolled_back_at timestamptz,
  UNIQUE (tenant_id, action_digest)
);

CREATE TABLE IF NOT EXISTS pi_readiness_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  release_id uuid NOT NULL REFERENCES pi_release_candidates(id),
  ready boolean NOT NULL,
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  failure_digest text CHECK (failure_digest IS NULL OR failure_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS pi_secret_leases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL,
  audience text NOT NULL,
  reference_digest text NOT NULL CHECK (reference_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_actor_id uuid REFERENCES users(id),
  CHECK (expires_at > issued_at)
);

CREATE TABLE IF NOT EXISTS pi_preproduction_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('pi.preproduction.readiness_evaluated','pi.release.promoted','pi.release.rolled_back','pi.secret.lease_issued','pi.secret.lease_revoked')),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_release_candidates_tenant_status ON pi_release_candidates(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_readiness_snapshots_release_time ON pi_readiness_snapshots(tenant_id, release_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_secret_leases_tenant_status ON pi_secret_leases(tenant_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pi_preproduction_events_tenant_time ON pi_preproduction_events(tenant_id, created_at DESC);

ALTER TABLE pi_release_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_release_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_readiness_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_readiness_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_secret_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_secret_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_preproduction_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_preproduction_events FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_release_candidates_tenant_policy ON pi_release_candidates USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_readiness_snapshots_tenant_policy ON pi_readiness_snapshots USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_secret_leases_tenant_policy ON pi_secret_leases USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_preproduction_events_tenant_policy ON pi_preproduction_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_release_candidates FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_readiness_snapshots FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_secret_leases FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_preproduction_events FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
