BEGIN;

ALTER TABLE connector_deliveries DROP CONSTRAINT connector_deliveries_status_check;
ALTER TABLE connector_deliveries ADD CONSTRAINT connector_deliveries_status_check
  CHECK (status IN ('pending','accepted','delivered','retry_scheduled','failed','unknown','cancelled'));

CREATE TABLE connector_test_notification_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider IN ('feishu','dingtalk','wecom')),
  connection_id uuid NOT NULL REFERENCES connections(id),
  acceptance_run_id uuid NOT NULL REFERENCES enterprise_acceptance_runs(id),
  recipient_type text NOT NULL CHECK (recipient_type IN ('user','chat')),
  recipient_digest text NOT NULL CHECK (recipient_digest ~ '^[a-f0-9]{64}$'),
  message_version integer NOT NULL CHECK (message_version > 0),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','executing','delivered','failed','unknown','cancelled')),
  result_status text CHECK (result_status IN ('delivered','failed','unknown')),
  receipt_digest text CHECK (receipt_digest IS NULL OR receipt_digest ~ '^[a-f0-9]{64}$'),
  error_category text,
  trace_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  UNIQUE (tenant_id, proposal_hash),
  CHECK (expires_at > created_at),
  CHECK (
    (status IN ('pending','executing') AND result_status IS NULL)
    OR (status IN ('delivered','failed','unknown') AND result_status = status)
    OR status = 'cancelled'
  )
);

CREATE INDEX idx_connector_test_notification_pending
  ON connector_test_notification_proposals(tenant_id,status,expires_at);

ALTER TABLE connector_test_notification_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_test_notification_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_test_notification_select_policy ON connector_test_notification_proposals
  FOR SELECT USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY connector_test_notification_insert_policy ON connector_test_notification_proposals
  FOR INSERT WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY connector_test_notification_update_policy ON connector_test_notification_proposals
  FOR UPDATE USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- No DELETE policy: confirmation and outcome evidence cannot be removed by tenant sessions.

CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE ON connector_test_notification_proposals
FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
