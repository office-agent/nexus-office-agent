BEGIN;

CREATE TABLE IF NOT EXISTS pi_change_submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  pi_run_id uuid NOT NULL REFERENCES pi_run_manifests(run_id),
  pi_workspace_id uuid NOT NULL REFERENCES pi_workspaces(id),
  repository_id uuid NOT NULL REFERENCES workspace_repositories(id),
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40,64}$'),
  head_commit_sha text NOT NULL CHECK (head_commit_sha ~ '^[a-f0-9]{40,64}$'),
  branch text NOT NULL CHECK (branch ~ '^pi/[A-Za-z0-9._/-]+$'),
  target_branch text NOT NULL CHECK (target_branch !~ '[.]{2}' AND target_branch !~ '^refs/'),
  diff_digest text NOT NULL CHECK (diff_digest ~ '^[a-f0-9]{64}$'),
  change_set_digest text NOT NULL CHECK (change_set_digest ~ '^[a-f0-9]{64}$'),
  validation_digest text NOT NULL CHECK (validation_digest ~ '^[a-f0-9]{64}$'),
  checkpoint_ids jsonb NOT NULL CHECK (jsonb_typeof(checkpoint_ids) = 'array'),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  approval_id uuid NOT NULL REFERENCES pi_approvals(id),
  approval_hash text NOT NULL CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('awaiting_approval','queued','submitted','failed','unknown','cancelled')),
  version integer NOT NULL CHECK (version > 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pi_pull_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  submission_id uuid NOT NULL REFERENCES pi_change_submissions(id),
  provider text NOT NULL CHECK (provider IN ('forgejo','github','gitlab','other')),
  repository_id uuid NOT NULL REFERENCES workspace_repositories(id),
  repository_ref text NOT NULL,
  branch text NOT NULL CHECK (branch ~ '^pi/[A-Za-z0-9._/-]+$'),
  target_branch text NOT NULL,
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40,64}$'),
  head_commit_sha text NOT NULL CHECK (head_commit_sha ~ '^[a-f0-9]{40,64}$'),
  external_id text,
  external_url text,
  status text NOT NULL CHECK (status IN ('pending','open','mergeable','conflicted','merged','closed','failed','unknown')),
  mergeability text NOT NULL CHECK (mergeability IN ('unknown','mergeable','conflicted','blocked')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, submission_id)
);

CREATE TABLE IF NOT EXISTS pi_merge_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  pi_run_id uuid NOT NULL REFERENCES pi_run_manifests(run_id),
  submission_id uuid NOT NULL REFERENCES pi_change_submissions(id),
  pull_request_id uuid NOT NULL REFERENCES pi_pull_requests(id),
  target_branch text NOT NULL,
  approval_id uuid NOT NULL REFERENCES pi_approvals(id),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  expected_object_versions jsonb NOT NULL CHECK (jsonb_typeof(expected_object_versions) = 'object'),
  status text NOT NULL CHECK (status IN ('awaiting_approval','queued','succeeded','failed','unknown','cancelled')),
  version integer NOT NULL CHECK (version > 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pi_release_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  pi_run_id uuid NOT NULL REFERENCES pi_run_manifests(run_id),
  submission_id uuid NOT NULL REFERENCES pi_change_submissions(id),
  pull_request_id uuid REFERENCES pi_pull_requests(id),
  environment text NOT NULL CHECK (environment ~ '^[a-z][a-z0-9-]{0,63}$'),
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  approval_id uuid NOT NULL REFERENCES pi_approvals(id),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  expected_object_versions jsonb NOT NULL CHECK (jsonb_typeof(expected_object_versions) = 'object'),
  status text NOT NULL CHECK (status IN ('awaiting_approval','queued','succeeded','failed','unknown','cancelled')),
  version integer NOT NULL CHECK (version > 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pi_delivery_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  pi_run_id uuid NOT NULL REFERENCES pi_run_manifests(run_id),
  action_type text NOT NULL CHECK (action_type IN ('create_pull_request','refresh_mergeability','propose_merge','propose_release')),
  entity_id uuid NOT NULL,
  approval_id uuid REFERENCES pi_approvals(id),
  proposal_hash text CHECK (proposal_hash IS NULL OR proposal_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('awaiting_approval','queued','leased','succeeded','failed','unknown','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  idempotency_key text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  external_id text,
  external_url text,
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  last_error_code text,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pi_delivery_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  pi_session_id uuid NOT NULL REFERENCES pi_sessions(id),
  pi_run_id uuid NOT NULL REFERENCES pi_run_manifests(run_id),
  action_type text NOT NULL CHECK (action_type IN ('create_pull_request','refresh_mergeability','propose_merge','propose_release')),
  entity_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('pi.change.validated','pi.change.submitted','pi.change.pull_request_queued','pi.change.pull_request_result','pi.change.mergeability_queued','pi.change.merge_proposed','pi.change.release_proposed','pi.change.external_result_unknown')),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^[a-f0-9]{64}$'),
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_change_submissions_scope ON pi_change_submissions(tenant_id, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_pull_requests_scope ON pi_pull_requests(tenant_id, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_merge_proposals_scope ON pi_merge_proposals(tenant_id, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_release_proposals_scope ON pi_release_proposals(tenant_id, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pi_delivery_outbox_claim ON pi_delivery_outbox(tenant_id, status, updated_at, created_at);
CREATE INDEX IF NOT EXISTS idx_pi_delivery_events_scope ON pi_delivery_events(tenant_id, actor_id, created_at DESC);

ALTER TABLE pi_change_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_change_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_pull_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_merge_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_merge_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_release_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_release_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_delivery_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_delivery_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE pi_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi_delivery_events FORCE ROW LEVEL SECURITY;

CREATE POLICY pi_change_submissions_tenant_policy ON pi_change_submissions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_pull_requests_tenant_policy ON pi_pull_requests USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_merge_proposals_tenant_policy ON pi_merge_proposals USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_release_proposals_tenant_policy ON pi_release_proposals USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_delivery_outbox_tenant_policy ON pi_delivery_outbox USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY pi_delivery_events_tenant_policy ON pi_delivery_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_change_submissions FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_pull_requests FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_merge_proposals FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_release_proposals FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_delivery_outbox FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON pi_delivery_events FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
