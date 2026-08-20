BEGIN;

INSERT INTO permissions(id,code,description,risk_level) VALUES
  ('52000000-0000-4000-8000-000000000004','memory:read','Read the caller''s durable Agent memory',1),
  ('52000000-0000-4000-8000-000000000005','memory:write','Create the caller''s explicit durable Agent memory',2),
  ('52000000-0000-4000-8000-000000000006','memory:read_shared','Read shared tenant Agent memory within authorized context',1),
  ('52000000-0000-4000-8000-000000000007','memory:share','Create shared tenant or project Agent memory',2),
  ('52000000-0000-4000-8000-000000000008','memory:manage','Expire or revoke another actor''s durable Agent memory',3)
ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description,risk_level=EXCLUDED.risk_level;

CREATE TABLE agent_memory_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  tier text NOT NULL CHECK (tier IN ('conversation','context','long_term','task','situational')),
  kind text NOT NULL CHECK (length(btrim(kind)) BETWEEN 1 AND 120),
  scope_type text NOT NULL CHECK (scope_type IN ('user','tenant','conversation','project','mission','task','meeting','case')),
  scope_id text NOT NULL CHECK (length(btrim(scope_id)) BETWEEN 1 AND 160),
  owner_id uuid REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private','shared')),
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 2000),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes)='object'),
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_refs)='array'),
  source_type text NOT NULL CHECK (length(btrim(source_type)) BETWEEN 1 AND 120),
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 200),
  origin text NOT NULL CHECK (origin IN ('user_declared','conversation','context','task','situation','system')),
  importance smallint NOT NULL CHECK (importance BETWEEN 0 AND 100),
  confidence smallint NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','expired','revoked')),
  expires_at timestamptz,
  supersedes_id uuid REFERENCES agent_memory_entries(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((visibility='private' AND owner_id IS NOT NULL) OR visibility='shared'),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE UNIQUE INDEX ux_agent_memory_entries_source
  ON agent_memory_entries(tenant_id,tier,kind,source_type,source_id);
CREATE INDEX idx_agent_memory_entries_scope
  ON agent_memory_entries(tenant_id,scope_type,scope_id,status,updated_at DESC);
CREATE INDEX idx_agent_memory_entries_owner
  ON agent_memory_entries(tenant_id,owner_id,tier,status,updated_at DESC) WHERE owner_id IS NOT NULL;
CREATE INDEX idx_agent_memory_entries_expiry
  ON agent_memory_entries(tenant_id,expires_at) WHERE expires_at IS NOT NULL AND status='active';

ALTER TABLE agent_memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_memory_entries_tenant_select_policy ON agent_memory_entries FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY agent_memory_entries_tenant_insert_policy ON agent_memory_entries FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY agent_memory_entries_tenant_update_policy ON agent_memory_entries FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON agent_memory_entries
  FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change();

COMMIT;
