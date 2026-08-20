BEGIN;

ALTER TABLE inbox_events
  ADD COLUMN event_envelope jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_token uuid,
  ADD COLUMN leased_at timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN last_error_digest text,
  ADD COLUMN result_digest text,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE inbox_events DROP CONSTRAINT inbox_events_status_check;
ALTER TABLE inbox_events ADD CONSTRAINT inbox_events_status_check
  CHECK (status IN ('received','processing','retry_scheduled','processed','failed','unknown','dead_letter'));
ALTER TABLE inbox_events ADD CONSTRAINT inbox_events_lease_consistency_check CHECK (
  (lease_token IS NULL AND lease_owner IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
  OR
  (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > leased_at)
);

DROP INDEX idx_inbox_status;
CREATE INDEX idx_inbox_claimable
  ON inbox_events(tenant_id, available_at, received_at)
  WHERE status IN ('received','retry_scheduled','processing');
CREATE INDEX idx_inbox_expired_lease
  ON inbox_events(lease_expires_at)
  WHERE status='processing';

ALTER TABLE outbox_events
  ADD COLUMN status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','retry_scheduled','published','failed','unknown','dead_letter')),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_token uuid,
  ADD COLUMN leased_at timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN last_error_digest text,
  ADD COLUMN result_digest text,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_lease_consistency_check CHECK (
  (lease_token IS NULL AND lease_owner IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
  OR
  (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > leased_at)
);

UPDATE outbox_events SET status='published' WHERE published_at IS NOT NULL;
DROP INDEX idx_outbox_pending;
CREATE INDEX idx_outbox_claimable
  ON outbox_events(tenant_id, available_at, occurred_at)
  WHERE status IN ('pending','retry_scheduled','processing');
CREATE INDEX idx_outbox_expired_lease
  ON outbox_events(lease_expires_at)
  WHERE status='processing';

CREATE TABLE agent_tool_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
  proposal_id uuid NOT NULL REFERENCES agent_proposals(id),
  confirmation_id uuid NOT NULL REFERENCES confirmations(id),
  tool_call_id uuid NOT NULL REFERENCES tool_calls(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  session_id text,
  channel text NOT NULL CHECK (channel IN ('web','feishu','dingtalk','wecom','system')),
  connection_id uuid REFERENCES connections(id),
  trace_id text NOT NULL,
  tool_id text NOT NULL,
  tool_version integer NOT NULL CHECK (tool_version > 0),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  risk_level smallint NOT NULL CHECK (risk_level BETWEEN 0 AND 4),
  input_payload jsonb NOT NULL,
  input_digest text NOT NULL,
  idempotency_key text NOT NULL,
  expected_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('queued','executing','retry_scheduled','succeeded','failed','unknown','dead_letter','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_digest text,
  result_payload jsonb,
  result_digest text,
  unknown_reason text,
  dead_lettered_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, proposal_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (lease_token IS NULL AND lease_owner IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > leased_at)
  )
);

CREATE INDEX idx_agent_tool_jobs_claimable
  ON agent_tool_jobs(tenant_id, available_at, created_at)
  WHERE status IN ('queued','retry_scheduled','executing');
CREATE INDEX idx_agent_tool_jobs_expired_lease
  ON agent_tool_jobs(lease_expires_at)
  WHERE status='executing';
CREATE INDEX idx_agent_tool_jobs_run
  ON agent_tool_jobs(tenant_id, agent_run_id, created_at DESC);

CREATE TABLE domain_event_publications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outbox_event_id uuid NOT NULL REFERENCES outbox_events(id),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL,
  payload jsonb NOT NULL,
  trace_id text NOT NULL,
  publisher_instance_id text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, outbox_event_id)
);

CREATE INDEX idx_domain_event_publications_time
  ON domain_event_publications(tenant_id, published_at DESC);

CREATE TABLE worker_heartbeats (
  role text NOT NULL CHECK (role IN ('inbox','agent','outbox')),
  instance_id text NOT NULL,
  release_version text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  draining boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role, instance_id)
);

CREATE INDEX idx_worker_heartbeats_role_freshness
  ON worker_heartbeats(role, last_seen_at DESC);

ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('created','running','awaiting_confirmation','queued','executing','succeeded','failed','unknown','awaiting_human','cancelled'));

ALTER TABLE agent_proposals DROP CONSTRAINT agent_proposals_status_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_status_check
  CHECK (status IN ('pending','confirmed','queued','executing','expired','revoked','executed','failed','unknown','cancelled'));

ALTER TABLE tool_calls DROP CONSTRAINT tool_calls_status_check;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_status_check
  CHECK (status IN ('planned','policy_checked','awaiting_confirmation','queued','executing','succeeded','failed','unknown','dead_letter','cancelled','compensated'));

ALTER TABLE agent_tool_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_tool_jobs_tenant_select_policy ON agent_tool_jobs FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY agent_tool_jobs_tenant_insert_policy ON agent_tool_jobs FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY agent_tool_jobs_tenant_update_policy ON agent_tool_jobs FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE domain_event_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_event_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY domain_event_publications_tenant_select_policy ON domain_event_publications FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY domain_event_publications_tenant_insert_policy ON domain_event_publications FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON agent_tool_jobs
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

CREATE TRIGGER nexus_atomic_audit
  AFTER INSERT OR UPDATE OR DELETE ON domain_event_publications
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
