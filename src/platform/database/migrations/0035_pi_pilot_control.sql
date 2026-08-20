BEGIN;

CREATE TABLE IF NOT EXISTS pi_pilots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  exit_policy_digest text NOT NULL CHECK (exit_policy_digest ~ '^[0-9a-f]{64}$'),
  action_digest text NOT NULL CHECK (action_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('draft','active','paused','exited')),
  created_at timestamptz NOT NULL DEFAULT now(),
  exited_at timestamptz,
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, action_digest)
);

CREATE TABLE IF NOT EXISTS pi_pilot_participants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pilot_id uuid NOT NULL REFERENCES pi_pilots(id),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  role text NOT NULL,
  project_scope_digest text NOT NULL CHECK (project_scope_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, pilot_id, subject_digest)
);

CREATE TABLE IF NOT EXISTS pi_pilot_journeys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pilot_id uuid NOT NULL REFERENCES pi_pilots(id),
  kind text NOT NULL CHECK (kind IN ('new_feature','bug_fix','refactor','test_failure_repair','code_review','pull_request')),
  sample_digest text NOT NULL CHECK (sample_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','verified','rejected')),
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  run_digest text CHECK (run_digest IS NULL OR run_digest ~ '^[0-9a-f]{64}$'),
  artifact_digest text CHECK (artifact_digest IS NULL OR artifact_digest ~ '^[0-9a-f]{64}$'),
  quality_score numeric CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_pilot_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pilot_id uuid NOT NULL REFERENCES pi_pilots(id),
  metric text NOT NULL CHECK (metric IN ('stability','quality','cost','security','adoption','data_access')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  value numeric NOT NULL,
  threshold numeric NOT NULL,
  unit text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','verified','rejected')),
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end >= window_start)
);

CREATE TABLE IF NOT EXISTS pi_pilot_data_samples (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pilot_id uuid NOT NULL REFERENCES pi_pilots(id),
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  sample_digest text NOT NULL CHECK (sample_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','verified','rejected')),
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_pilot_incidents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pilot_id uuid NOT NULL REFERENCES pi_pilots(id),
  severity text NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  status text NOT NULL CHECK (status IN ('open','resolved')),
  summary_digest text NOT NULL CHECK (summary_digest ~ '^[0-9a-f]{64}$'),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS pi_pilot_readiness (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pilot_id uuid NOT NULL REFERENCES pi_pilots(id),
  ready boolean NOT NULL,
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  failure_digest text CHECK (failure_digest IS NULL OR failure_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS pi_pilot_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pilot_id uuid NOT NULL REFERENCES pi_pilots(id),
  kind text NOT NULL CHECK (kind IN ('pi.pilot.created','pi.pilot.journey_recorded','pi.pilot.observation_recorded','pi.pilot.incident_recorded','pi.pilot.readiness_evaluated','pi.pilot.exited')),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_pilots_tenant_status ON pi_pilots(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_pilot_participants_tenant_pilot ON pi_pilot_participants(tenant_id, pilot_id, status);
CREATE INDEX IF NOT EXISTS idx_pi_pilot_journeys_tenant_pilot_kind ON pi_pilot_journeys(tenant_id, pilot_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_pi_pilot_observations_tenant_pilot_metric ON pi_pilot_observations(tenant_id, pilot_id, metric, status);
CREATE INDEX IF NOT EXISTS idx_pi_pilot_data_samples_tenant_pilot ON pi_pilot_data_samples(tenant_id, pilot_id, status);
CREATE INDEX IF NOT EXISTS idx_pi_pilot_incidents_tenant_pilot ON pi_pilot_incidents(tenant_id, pilot_id, severity, status);
CREATE INDEX IF NOT EXISTS idx_pi_pilot_readiness_tenant_pilot ON pi_pilot_readiness(tenant_id, pilot_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_pilot_events_tenant_time ON pi_pilot_events(tenant_id, created_at DESC);

ALTER TABLE pi_pilots ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pilots FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_journeys FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_data_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_data_samples FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_readiness FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pilot_events FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_pilots_tenant_policy ON pi_pilots USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_pilot_participants_tenant_policy ON pi_pilot_participants USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_pilot_journeys_tenant_policy ON pi_pilot_journeys USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_pilot_observations_tenant_policy ON pi_pilot_observations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_pilot_data_samples_tenant_policy ON pi_pilot_data_samples USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_pilot_incidents_tenant_policy ON pi_pilot_incidents USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_pilot_readiness_tenant_policy ON pi_pilot_readiness USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_pilot_events_tenant_policy ON pi_pilot_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pilots FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pilot_participants FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pilot_journeys FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pilot_observations FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pilot_data_samples FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pilot_incidents FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pilot_readiness FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pilot_events FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
