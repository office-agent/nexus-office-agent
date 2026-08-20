BEGIN;

ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS owner_actor_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS credential_ref text,
  ADD COLUMN IF NOT EXISTS signature text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS schema_digest text,
  ADD COLUMN IF NOT EXISTS tool_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS circuit_state text NOT NULL DEFAULT 'closed',
  ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS circuit_opened_until timestamptz,
  ADD COLUMN IF NOT EXISTS probed_at timestamptz;

ALTER TABLE mcp_servers
  ADD CONSTRAINT mcp_servers_circuit_state_check CHECK (circuit_state IN ('closed','open'));

ALTER TABLE mcp_tool_bindings
  ADD COLUMN IF NOT EXISTS server_digest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS schema_digest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS data_classification text NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS allowed_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'tenant',
  ADD COLUMN IF NOT EXISTS scope_id text,
  ADD COLUMN IF NOT EXISTS network_policy_ref text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE mcp_tool_bindings
  ADD CONSTRAINT mcp_tool_bindings_scope_type_check CHECK (scope_type IN ('tenant','project','user')),
  ADD CONSTRAINT mcp_tool_bindings_classification_check CHECK (data_classification IN ('public','internal','confidential','restricted'));

ALTER TABLE pi_tool_calls
  ADD COLUMN IF NOT EXISTS mcp_binding_id uuid REFERENCES mcp_tool_bindings(id),
  ADD COLUMN IF NOT EXISTS mcp_server_id text,
  ADD COLUMN IF NOT EXISTS mcp_server_version text,
  ADD COLUMN IF NOT EXISTS mcp_schema_digest text,
  ADD COLUMN IF NOT EXISTS result_classification text,
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS error_code text;

ALTER TABLE pi_sessions
  ADD COLUMN IF NOT EXISTS mcp_binding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mcp_bindings jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS pi_mcp_call_audits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  session_id uuid REFERENCES pi_sessions(id),
  run_id uuid,
  binding_id uuid NOT NULL REFERENCES mcp_tool_bindings(id),
  server_id text NOT NULL,
  server_version text NOT NULL,
  tool_name text NOT NULL,
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  output_digest text CHECK (output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
  result_classification text NOT NULL CHECK (result_classification IN ('public','internal','confidential','restricted')),
  status text NOT NULL CHECK (status IN ('authorized','succeeded','failed','denied','circuit_open')),
  error_code text,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(tenant_id, id, version, approval_status);
CREATE INDEX IF NOT EXISTS idx_mcp_bindings_scope ON mcp_tool_bindings(tenant_id, exposed_name, scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS idx_pi_mcp_call_audits_scope ON pi_mcp_call_audits(tenant_id, created_at DESC);

ALTER TABLE pi_mcp_call_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_mcp_call_audits FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_mcp_call_audits_tenant_policy ON pi_mcp_call_audits
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_mcp_call_audits
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
