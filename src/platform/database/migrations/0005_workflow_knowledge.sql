BEGIN;

CREATE TABLE process_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('draft','published','retired')),
  current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE process_definition_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  definition_id uuid NOT NULL REFERENCES process_definitions(id),
  version integer NOT NULL CHECK (version > 0),
  start_node_key text NOT NULL,
  nodes jsonb NOT NULL,
  published_by uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, definition_id, version)
);

CREATE TABLE process_instances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  definition_id uuid NOT NULL REFERENCES process_definitions(id),
  definition_version integer NOT NULL CHECK (definition_version > 0),
  requester_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  form_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('running','approved','rejected','withdrawn','cancelled','failed')),
  current_node_key text NOT NULL,
  risk_level smallint NOT NULL CHECK (risk_level BETWEEN 0 AND 4),
  sla_due_at timestamptz,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, definition_id, definition_version)
    REFERENCES process_definition_versions(tenant_id, definition_id, version)
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  instance_id uuid NOT NULL REFERENCES process_instances(id),
  node_key text NOT NULL,
  approver_id uuid NOT NULL REFERENCES users(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','delegated','cancelled','escalated')),
  decision text CHECK (decision IN ('approve','reject')),
  comment text,
  delegated_from_id uuid REFERENCES approvals(id),
  delegated_to_id uuid REFERENCES users(id),
  escalated_from_id uuid REFERENCES approvals(id),
  escalation_level smallint CHECK (escalation_level IS NULL OR escalation_level > 0),
  due_at timestamptz NOT NULL,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, instance_id, node_key, approver_id, delegated_from_id)
);

CREATE TABLE meeting_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid REFERENCES projects(id),
  title text NOT NULL,
  organizer_id uuid NOT NULL REFERENCES users(id),
  participant_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_confirmer_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_by_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  starts_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','pending_confirmation','confirmed','cancelled')),
  draft_minutes jsonb NOT NULL,
  confirmed_minutes jsonb,
  outcome_status text NOT NULL CHECK (outcome_status IN ('not_ready','pending','materialized')),
  confirmed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  status text NOT NULL CHECK (status IN ('draft','published','archived')),
  current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  access_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  version integer NOT NULL CHECK (version > 0),
  content text NOT NULL,
  content_digest text NOT NULL CHECK (length(content_digest) = 64),
  source_ref text,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  supersedes_version integer,
  published_by uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_id, version),
  CHECK (expires_at IS NULL OR expires_at > effective_at)
);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  document_version integer NOT NULL CHECK (document_version > 0),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  locator text NOT NULL,
  permission_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active','invalidated')),
  content_digest text NOT NULL CHECK (length(content_digest) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  UNIQUE (tenant_id, document_id, document_version, chunk_index),
  FOREIGN KEY (tenant_id, document_id, document_version)
    REFERENCES document_versions(tenant_id, document_id, version)
);

CREATE INDEX idx_process_instances_requester ON process_instances(tenant_id, requester_id, status, created_at DESC);
CREATE INDEX idx_approvals_pending ON approvals(tenant_id, approver_id, due_at) WHERE status = 'pending';
CREATE INDEX idx_meetings_participants ON meeting_records(tenant_id, starts_at DESC);
CREATE INDEX idx_documents_status ON documents(tenant_id, status, classification);
CREATE INDEX idx_knowledge_active_document ON knowledge_items(tenant_id, document_id, document_version) WHERE status = 'active';

ALTER TABLE process_definitions ENABLE ROW LEVEL SECURITY; ALTER TABLE process_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE process_definition_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE process_definition_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE process_instances ENABLE ROW LEVEL SECURITY; ALTER TABLE process_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY; ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_records ENABLE ROW LEVEL SECURITY; ALTER TABLE meeting_records FORCE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY; ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_items ENABLE ROW LEVEL SECURITY; ALTER TABLE knowledge_items FORCE ROW LEVEL SECURITY;

CREATE POLICY process_definitions_tenant_policy ON process_definitions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY process_definition_versions_tenant_policy ON process_definition_versions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY process_instances_tenant_policy ON process_instances USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY approvals_tenant_policy ON approvals USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY meeting_records_tenant_policy ON meeting_records USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY documents_tenant_policy ON documents USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY document_versions_tenant_policy ON document_versions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY knowledge_items_tenant_policy ON knowledge_items USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
