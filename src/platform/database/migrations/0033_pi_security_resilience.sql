BEGIN;

CREATE TABLE IF NOT EXISTS pi_security_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('cross_tenant_denied','prompt_injection_detected','malicious_repository_context','ssrf_denied','metadata_denied','sandbox_boundary_denied','resource_revoked','capacity_rejected','fault_injected','kill_switch_activated','kill_switch_released','dependency_failed','recovery_started','recovery_completed')),
  severity text NOT NULL CHECK (severity IN ('P0','P1','P2')),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  reason_code text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_kill_switches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL CHECK (scope IN ('global','tenant','profile','model','resource')),
  target_digest text CHECK (target_digest IS NULL OR target_digest ~ '^[0-9a-f]{64}$'),
  target_profile text,
  target_model_route_id text,
  reason_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','released')),
  activated_by uuid NOT NULL REFERENCES users(id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_actor_id uuid REFERENCES users(id),
  version integer NOT NULL CHECK (version > 0),
  action_digest text NOT NULL CHECK (action_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS pi_capacity_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL CHECK (scope IN ('tenant','profile')),
  scope_id text,
  version integer NOT NULL CHECK (version > 0),
  max_concurrent_runs bigint NOT NULL CHECK (max_concurrent_runs > 0),
  max_queue_depth bigint NOT NULL CHECK (max_queue_depth > 0),
  max_prompt_bytes bigint NOT NULL CHECK (max_prompt_bytes > 0),
  max_event_bytes bigint NOT NULL CHECK (max_event_bytes > 0),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope, scope_id, version)
);

CREATE TABLE IF NOT EXISTS pi_capacity_leases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  run_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('tenant','profile')),
  scope_id text,
  policy_id uuid NOT NULL REFERENCES pi_capacity_policies(id),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','released')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pi_fault_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  target text NOT NULL CHECK (target IN ('queue.claim','runner.runtime','model.provider','telemetry.write','object.store','database.query')),
  error_code text NOT NULL,
  remaining integer NOT NULL CHECK (remaining >= 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, target)
);

CREATE INDEX IF NOT EXISTS idx_pi_security_events_tenant_time ON pi_security_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_kill_switches_scope_status ON pi_kill_switches(tenant_id, scope, status);
CREATE INDEX IF NOT EXISTS idx_pi_capacity_leases_policy_status ON pi_capacity_leases(tenant_id, policy_id, status);

ALTER TABLE pi_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_security_events FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_kill_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_kill_switches FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_capacity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_capacity_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_capacity_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_capacity_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_fault_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_fault_plans FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_security_events_tenant_policy ON pi_security_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_kill_switches_tenant_policy ON pi_kill_switches USING (scope = 'global' OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (scope = 'global' OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_capacity_policies_tenant_policy ON pi_capacity_policies USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_capacity_leases_tenant_policy ON pi_capacity_leases USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_fault_plans_tenant_policy ON pi_fault_plans USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_security_events FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_kill_switches FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_capacity_policies FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_capacity_leases FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_fault_plans FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
