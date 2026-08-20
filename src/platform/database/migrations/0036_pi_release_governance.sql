BEGIN;

CREATE TABLE IF NOT EXISTS pi_publications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  version text NOT NULL,
  upstream_version text NOT NULL,
  api_digest text NOT NULL CHECK (api_digest ~ '^[0-9a-f]{64}$'),
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  image_digest text NOT NULL CHECK (image_digest ~ '^[0-9a-f]{64}$'),
  signature_digest text NOT NULL CHECK (signature_digest ~ '^[0-9a-f]{64}$'),
  sbom_digest text NOT NULL CHECK (sbom_digest ~ '^[0-9a-f]{64}$'),
  rollback_digest text NOT NULL CHECK (rollback_digest ~ '^[0-9a-f]{64}$'),
  pilot_readiness_digest text CHECK (pilot_readiness_digest IS NULL OR pilot_readiness_digest ~ '^[0-9a-f]{64}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('draft','candidate','approved','rolling_out','active','rolled_back','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (tenant_id, action_digest)
);

CREATE TABLE IF NOT EXISTS pi_gate_attestations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  publication_id uuid NOT NULL REFERENCES pi_publications(id),
  gate_id text NOT NULL CHECK (gate_id ~ '^G-0(2[5-9]|3[0-7])$'),
  status text NOT NULL CHECK (status IN ('pending','pass','fail','expired')),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  valid_until timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_release_risks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  publication_id uuid NOT NULL REFERENCES pi_publications(id),
  severity text NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  status text NOT NULL CHECK (status IN ('open','mitigated','accepted')),
  summary_digest text NOT NULL CHECK (summary_digest ~ '^[0-9a-f]{64}$'),
  mitigation_digest text CHECK (mitigation_digest IS NULL OR mitigation_digest ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS pi_release_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  publication_id uuid NOT NULL REFERENCES pi_publications(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('release_manager','security_reviewer','operations_reviewer')),
  decision text NOT NULL CHECK (decision IN ('pending','approved','rejected')),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_rollouts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  publication_id uuid NOT NULL REFERENCES pi_publications(id),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[0-9a-f]{64}$'),
  capability_digest text NOT NULL CHECK (capability_digest ~ '^[0-9a-f]{64}$'),
  stage text NOT NULL CHECK (stage IN ('canary','pilot','general')),
  status text NOT NULL CHECK (status IN ('planned','running','completed','paused','rolled_back')),
  previous_version_digest text NOT NULL CHECK (previous_version_digest ~ '^[0-9a-f]{64}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, action_digest)
);

CREATE TABLE IF NOT EXISTS pi_release_evaluations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  publication_id uuid NOT NULL REFERENCES pi_publications(id),
  status text NOT NULL CHECK (status IN ('passed','regressed','blocked','unknown')),
  suite_digest text NOT NULL CHECK (suite_digest ~ '^[0-9a-f]{64}$'),
  score numeric NOT NULL CHECK (score >= 0 AND score <= 1),
  threshold numeric NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_release_gate_evaluations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  publication_id uuid NOT NULL REFERENCES pi_publications(id),
  ready boolean NOT NULL,
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  failure_digest text CHECK (failure_digest IS NULL OR failure_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS pi_release_governance_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  publication_id uuid NOT NULL REFERENCES pi_publications(id),
  kind text NOT NULL CHECK (kind IN ('pi.publication.gate_evaluated','pi.publication.approved','pi.publication.rollout_changed','pi.publication.revoked')),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_publications_tenant_status ON pi_publications(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_gate_attestations_tenant_publication ON pi_gate_attestations(tenant_id, publication_id, gate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_release_risks_tenant_publication ON pi_release_risks(tenant_id, publication_id, severity, status);
CREATE INDEX IF NOT EXISTS idx_pi_release_approvals_tenant_publication ON pi_release_approvals(tenant_id, publication_id, decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_rollouts_tenant_publication ON pi_rollouts(tenant_id, publication_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_release_evaluations_tenant_publication ON pi_release_evaluations(tenant_id, publication_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_release_gate_evaluations_tenant_publication ON pi_release_gate_evaluations(tenant_id, publication_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_release_governance_events_tenant_time ON pi_release_governance_events(tenant_id, created_at DESC);

ALTER TABLE pi_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_gate_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_gate_attestations FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_release_risks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_release_risks FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_release_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_release_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_rollouts FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_release_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_release_evaluations FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_release_gate_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_release_gate_evaluations FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_release_governance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_release_governance_events FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_publications_tenant_policy ON pi_publications USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_gate_attestations_tenant_policy ON pi_gate_attestations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_release_risks_tenant_policy ON pi_release_risks USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_release_approvals_tenant_policy ON pi_release_approvals USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_rollouts_tenant_policy ON pi_rollouts USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_release_evaluations_tenant_policy ON pi_release_evaluations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_release_gate_evaluations_tenant_policy ON pi_release_gate_evaluations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_release_governance_events_tenant_policy ON pi_release_governance_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_publications FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_gate_attestations FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_release_risks FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_release_approvals FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_rollouts FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_release_evaluations FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_release_gate_evaluations FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_release_governance_events FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
