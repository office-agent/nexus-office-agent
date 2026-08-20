BEGIN;

ALTER TABLE agent_runs
  ADD COLUMN client_request_id text,
  ADD COLUMN input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN output_payload jsonb,
  ADD COLUMN failure_category text;

CREATE UNIQUE INDEX idx_agent_runs_client_request
  ON agent_runs(tenant_id, actor_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE agent_context_refs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
  object_type text NOT NULL,
  object_id text NOT NULL,
  object_version integer,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  excerpt_digest text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_citations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
  object_type text NOT NULL,
  object_id text NOT NULL,
  object_version integer,
  label text NOT NULL,
  excerpt text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  retrieved_at timestamptz NOT NULL,
  ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_run_id, ordinal)
);

CREATE TABLE agent_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  tool_id text NOT NULL,
  tool_version integer NOT NULL,
  risk_level smallint NOT NULL CHECK (risk_level BETWEEN 0 AND 4),
  input_payload jsonb NOT NULL,
  input_digest text NOT NULL,
  preview text NOT NULL,
  expected_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposal_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','confirmed','expired','revoked','executed','failed')),
  expires_at timestamptz NOT NULL,
  result_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  UNIQUE(tenant_id, proposal_hash)
);

ALTER TABLE confirmations ADD COLUMN proposal_id uuid REFERENCES agent_proposals(id);
CREATE INDEX idx_confirmations_proposal ON confirmations(tenant_id, proposal_id, status);

CREATE TABLE agent_evaluations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
  evaluator text NOT NULL,
  metric text NOT NULL,
  score numeric,
  passed boolean NOT NULL,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_context_run ON agent_context_refs(tenant_id, agent_run_id);
CREATE INDEX idx_agent_citations_run ON agent_citations(tenant_id, agent_run_id, ordinal);
CREATE INDEX idx_agent_proposals_pending ON agent_proposals(tenant_id, status, expires_at);
CREATE INDEX idx_agent_evaluations_metric ON agent_evaluations(tenant_id, metric, created_at DESC);

ALTER TABLE agent_context_refs ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_context_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_citations ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_citations FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_evaluations ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_evaluations FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_context_refs_tenant_policy ON agent_context_refs USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY agent_citations_tenant_policy ON agent_citations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY agent_proposals_tenant_policy ON agent_proposals USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY agent_evaluations_tenant_policy ON agent_evaluations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
