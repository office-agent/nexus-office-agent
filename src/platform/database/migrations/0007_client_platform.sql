CREATE TABLE client_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  client_type text NOT NULL CHECK (client_type IN ('web_pwa','desktop_pwa','mobile_pwa')),
  platform text NOT NULL CHECK (char_length(platform) BETWEEN 1 AND 80),
  app_version text NOT NULL CHECK (app_version ~ '^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$'),
  trust_level text NOT NULL CHECK (trust_level IN ('unmanaged','managed','attested')) DEFAULT 'unmanaged',
  status text NOT NULL CHECK (status IN ('pending','active','revoked')) DEFAULT 'pending',
  push_enabled boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  registered_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, user_id, installation_id),
  CHECK ((status = 'revoked' AND revoked_at IS NOT NULL) OR (status <> 'revoked' AND revoked_at IS NULL))
);

CREATE TABLE client_push_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES client_devices(id) ON DELETE CASCADE,
  endpoint_digest char(64) NOT NULL,
  encrypted_payload text NOT NULL,
  initialization_vector text NOT NULL,
  authentication_tag text NOT NULL,
  key_ref text NOT NULL CHECK (key_ref LIKE 'secret://%'),
  status text NOT NULL CHECK (status IN ('active','revoked')) DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, endpoint_digest),
  CHECK ((status = 'revoked' AND revoked_at IS NOT NULL) OR (status = 'active' AND revoked_at IS NULL))
);

CREATE INDEX idx_client_devices_user_status ON client_devices(tenant_id,user_id,status);
CREATE INDEX idx_client_push_device_status ON client_push_subscriptions(tenant_id,device_id,status);

ALTER TABLE client_devices ENABLE ROW LEVEL SECURITY; ALTER TABLE client_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE client_push_subscriptions ENABLE ROW LEVEL SECURITY; ALTER TABLE client_push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY client_devices_tenant_policy ON client_devices USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY client_push_subscriptions_tenant_policy ON client_push_subscriptions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
