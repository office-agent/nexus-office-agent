BEGIN;

ALTER TABLE connections ADD COLUMN IF NOT EXISTS transport_mode text CHECK (transport_mode IN ('stream','http'));
ALTER TABLE connections ADD COLUMN IF NOT EXISTS external_organization_id text;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0);

CREATE TABLE connection_installation_checks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connection_id uuid NOT NULL REFERENCES connections(id),
  provider text NOT NULL CHECK (provider IN ('feishu','dingtalk','wecom')),
  status text NOT NULL CHECK (status IN ('valid','invalid','degraded')),
  capability_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connection_id uuid NOT NULL REFERENCES connections(id),
  provider text NOT NULL CHECK (provider IN ('feishu','dingtalk','wecom')),
  notification_id text NOT NULL,
  idempotency_key text NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('user','chat')),
  recipient_digest text NOT NULL,
  message_type text NOT NULL CHECK (message_type IN ('info','action_required','confirmation','status_update','digest')),
  payload_digest text NOT NULL,
  external_message_id text,
  status text NOT NULL CHECK (status IN ('pending','accepted','delivered','retry_scheduled','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error_category text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, notification_id)
);

CREATE TABLE connector_sync_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connection_id uuid NOT NULL REFERENCES connections(id),
  resource_type text NOT NULL CHECK (resource_type IN ('organization','user','calendar','approval')),
  cursor text,
  watermark timestamptz,
  status text NOT NULL CHECK (status IN ('idle','running','failed')),
  last_error_category text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, resource_type)
);

CREATE TABLE channel_preferences (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  ordered_providers jsonb NOT NULL DEFAULT '["web"]'::jsonb,
  quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  digest_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE webhook_replay_claims (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connection_id uuid NOT NULL REFERENCES connections(id),
  provider text NOT NULL CHECK (provider IN ('feishu','dingtalk','wecom')),
  replay_key text NOT NULL,
  raw_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, replay_key)
);

CREATE INDEX idx_connector_deliveries_retry ON connector_deliveries(next_attempt_at) WHERE status = 'retry_scheduled';
CREATE INDEX idx_installation_checks_connection ON connection_installation_checks(tenant_id, connection_id, checked_at DESC);
CREATE INDEX idx_webhook_replay_expiry ON webhook_replay_claims(expires_at);

ALTER TABLE connection_installation_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_installation_checks FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_sync_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_replay_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_replay_claims FORCE ROW LEVEL SECURITY;

CREATE POLICY installation_checks_tenant_policy ON connection_installation_checks USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY connector_deliveries_tenant_policy ON connector_deliveries USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY connector_sync_cursors_tenant_policy ON connector_sync_cursors USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY channel_preferences_tenant_policy ON channel_preferences USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY webhook_replay_claims_tenant_policy ON webhook_replay_claims USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
