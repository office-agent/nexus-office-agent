BEGIN;

CREATE TABLE IF NOT EXISTS pi_model_routes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  route_id text NOT NULL,
  version text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  region text NOT NULL,
  egress text NOT NULL CHECK (egress IN ('private','public','local')),
  allowed_data_classifications text[] NOT NULL,
  fallback_route_ids text[] NOT NULL DEFAULT '{}',
  max_input_tokens bigint NOT NULL CHECK (max_input_tokens > 0),
  max_output_tokens bigint NOT NULL CHECK (max_output_tokens > 0),
  input_cost_micros_per_million bigint NOT NULL CHECK (input_cost_micros_per_million >= 0),
  output_cost_micros_per_million bigint NOT NULL CHECK (output_cost_micros_per_million >= 0),
  status text NOT NULL CHECK (status IN ('pending','approved','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (tenant_id, route_id, version)
);

CREATE TABLE IF NOT EXISTS pi_model_usage (
  usage_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  workspace_id text,
  session_id uuid,
  run_id uuid,
  route_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  data_classification text NOT NULL CHECK (data_classification IN ('public','internal','confidential','restricted')),
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  latency_ms bigint NOT NULL CHECK (latency_ms >= 0),
  status text NOT NULL CHECK (status IN ('succeeded','failed','cancelled','blocked')),
  idempotency_key text NOT NULL,
  cost_micros bigint NOT NULL CHECK (cost_micros >= 0),
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pi_traces (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  trace_id text NOT NULL,
  workspace_id text,
  session_id uuid,
  run_id uuid,
  sandbox_run_id uuid,
  tool_call_id uuid,
  model_route_id text,
  skill_digests text[] NOT NULL DEFAULT '{}',
  git_commit_sha text,
  data_classification text NOT NULL CHECK (data_classification IN ('public','internal','confidential','restricted')),
  status text NOT NULL CHECK (status IN ('started','succeeded','failed','blocked','cancelled','unknown')),
  input_digest text,
  output_digest text,
  duration_ms bigint,
  error_code text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS pi_telemetry_metrics (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  trace_id text NOT NULL,
  name text NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL CHECK (unit IN ('count','milliseconds','tokens','micros','ratio','bytes')),
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_evaluation_results (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  suite_id text NOT NULL,
  case_id text NOT NULL,
  route_id text,
  trace_id text,
  status text NOT NULL CHECK (status IN ('passed','failed','blocked','unknown')),
  score double precision NOT NULL CHECK (score >= 0 AND score <= 1),
  threshold double precision NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  metric_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_digest text,
  correction_required boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_regression_alerts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  suite_id text NOT NULL,
  metric text NOT NULL,
  baseline double precision NOT NULL,
  observed double precision NOT NULL,
  threshold double precision NOT NULL,
  severity text NOT NULL CHECK (severity IN ('P0','P1','P2')),
  status text NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pi_quota_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL CHECK (scope IN ('tenant','project','actor','profile')),
  scope_id text,
  version integer NOT NULL CHECK (version > 0),
  max_concurrent_runs bigint NOT NULL CHECK (max_concurrent_runs >= 0),
  max_tokens bigint NOT NULL CHECK (max_tokens >= 0),
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros >= 0),
  max_storage_bytes bigint NOT NULL CHECK (max_storage_bytes >= 0),
  max_tool_calls bigint NOT NULL CHECK (max_tool_calls >= 0),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope, scope_id, version)
);

CREATE TABLE IF NOT EXISTS pi_quota_reservations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  run_id uuid,
  scope text NOT NULL CHECK (scope IN ('tenant','project','actor','profile')),
  scope_id text,
  policy_id uuid NOT NULL REFERENCES pi_quota_policies(id),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  idempotency_key text NOT NULL,
  reserved jsonb NOT NULL,
  consumed jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('active','released','consumed','exhausted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pi_model_usage_tenant_time ON pi_model_usage(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_traces_tenant_time ON pi_traces(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_metrics_tenant_time ON pi_telemetry_metrics(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_eval_tenant_time ON pi_evaluation_results(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_alert_tenant_status ON pi_regression_alerts(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_quota_reservations_policy ON pi_quota_reservations(tenant_id, policy_id, status);

ALTER TABLE pi_model_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_model_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_model_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_model_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_traces FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_telemetry_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_telemetry_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_evaluation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_evaluation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_regression_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_regression_alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_quota_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_quota_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_quota_reservations FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_model_routes_tenant_policy ON pi_model_routes USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_model_usage_tenant_policy ON pi_model_usage USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_traces_tenant_policy ON pi_traces USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_telemetry_metrics_tenant_policy ON pi_telemetry_metrics USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_evaluation_results_tenant_policy ON pi_evaluation_results USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_regression_alerts_tenant_policy ON pi_regression_alerts USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_quota_policies_tenant_policy ON pi_quota_policies USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_quota_reservations_tenant_policy ON pi_quota_reservations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_model_routes FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_model_usage FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_traces FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_telemetry_metrics FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_evaluation_results FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_regression_alerts FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_quota_policies FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_quota_reservations FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
