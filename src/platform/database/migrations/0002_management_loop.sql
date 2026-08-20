BEGIN;

CREATE TABLE objectives (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('draft','proposed','active','at_risk','achieved','missed','cancelled','reviewed')),
  baseline numeric,
  target_value numeric,
  current_value numeric,
  unit text,
  starts_at date NOT NULL,
  ends_at date NOT NULL,
  review_cadence text NOT NULL DEFAULT 'weekly',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (ends_at >= starts_at)
);

CREATE TABLE key_results (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  objective_id uuid NOT NULL REFERENCES objectives(id),
  title text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  baseline numeric NOT NULL DEFAULT 0,
  target_value numeric NOT NULL,
  current_value numeric NOT NULL DEFAULT 0,
  unit text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','active','at_risk','achieved','missed','cancelled')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id uuid NOT NULL REFERENCES users(id),
  sponsor_id uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('draft','proposed','approved','active','paused','closing','completed','cancelled')),
  priority text NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  starts_at date NOT NULL,
  target_end_at date NOT NULL,
  actual_end_at date,
  budget numeric,
  currency text,
  health text NOT NULL CHECK (health IN ('unknown','healthy','watch','at_risk','critical')) DEFAULT 'unknown',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (tenant_id, code),
  CHECK (target_end_at >= starts_at)
);

CREATE TABLE objective_project_links (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  objective_id uuid NOT NULL REFERENCES objectives(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  contribution_weight numeric NOT NULL DEFAULT 1 CHECK (contribution_weight > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, objective_id, project_id)
);

CREATE TABLE project_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  responsibility text NOT NULL CHECK (responsibility IN ('accountable','responsible','consulted','informed')),
  allocation_percent integer CHECK (allocation_percent BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, user_id, responsibility)
);

CREATE TABLE milestones (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  due_at date NOT NULL,
  status text NOT NULL CHECK (status IN ('planned','active','at_risk','completed','missed','cancelled')),
  acceptance_criteria text NOT NULL,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  milestone_id uuid REFERENCES milestones(id),
  parent_id uuid REFERENCES tasks(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  assignee_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('todo','in_progress','blocked','in_review','completed','cancelled')),
  priority text NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  due_at timestamptz,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE risks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  description text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  probability smallint NOT NULL CHECK (probability BETWEEN 1 AND 5),
  impact smallint NOT NULL CHECK (impact BETWEEN 1 AND 5),
  exposure smallint GENERATED ALWAYS AS (probability * impact) STORED,
  status text NOT NULL CHECK (status IN ('identified','assessed','response_planned','monitoring','realized','closed','accepted')),
  response_strategy text CHECK (response_strategy IN ('avoid','mitigate','transfer','accept')),
  response_plan text,
  review_at timestamptz,
  source_type text NOT NULL CHECK (source_type IN ('human','agent','event','import')),
  source_ref text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issues (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  risk_id uuid REFERENCES risks(id),
  title text NOT NULL,
  description text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  status text NOT NULL CHECK (status IN ('open','investigating','resolving','resolved','closed')),
  resolution text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid REFERENCES projects(id),
  risk_id uuid REFERENCES risks(id),
  title text NOT NULL,
  context text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_option text,
  rationale text,
  owner_id uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('draft','under_review','decided','executing','verified','superseded','closed')),
  review_at timestamptz,
  supersedes_id uuid REFERENCES decisions(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('decided','executing','verified','superseded','closed') AND decided_by IS NOT NULL AND selected_option IS NOT NULL AND rationale IS NOT NULL) OR status IN ('draft','under_review'))
);

CREATE TABLE action_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  decision_id uuid REFERENCES decisions(id),
  project_id uuid REFERENCES projects(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id uuid NOT NULL REFERENCES users(id),
  due_at timestamptz NOT NULL,
  acceptance_criteria text NOT NULL,
  status text NOT NULL CHECK (status IN ('open','in_progress','blocked','completed','cancelled')),
  completed_at timestamptz,
  completion_evidence text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_objectives_owner ON objectives(tenant_id, owner_id, status);
CREATE INDEX idx_projects_owner_health ON projects(tenant_id, owner_id, health);
CREATE INDEX idx_milestones_due ON milestones(tenant_id, due_at, status);
CREATE INDEX idx_tasks_assignee_due ON tasks(tenant_id, assignee_id, due_at, status);
CREATE INDEX idx_risks_project_exposure ON risks(tenant_id, project_id, exposure DESC);
CREATE INDEX idx_decisions_project ON decisions(tenant_id, project_id, status);
CREATE INDEX idx_action_items_owner_due ON action_items(tenant_id, owner_id, due_at, status);

ALTER TABLE objectives ENABLE ROW LEVEL SECURITY; ALTER TABLE objectives FORCE ROW LEVEL SECURITY;
ALTER TABLE key_results ENABLE ROW LEVEL SECURITY; ALTER TABLE key_results FORCE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY; ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE objective_project_links ENABLE ROW LEVEL SECURITY; ALTER TABLE objective_project_links FORCE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY; ALTER TABLE project_members FORCE ROW LEVEL SECURITY;
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY; ALTER TABLE milestones FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE risks ENABLE ROW LEVEL SECURITY; ALTER TABLE risks FORCE ROW LEVEL SECURITY;
ALTER TABLE issues ENABLE ROW LEVEL SECURITY; ALTER TABLE issues FORCE ROW LEVEL SECURITY;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY; ALTER TABLE decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE action_items ENABLE ROW LEVEL SECURITY; ALTER TABLE action_items FORCE ROW LEVEL SECURITY;

CREATE POLICY objectives_tenant_policy ON objectives USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY key_results_tenant_policy ON key_results USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY projects_tenant_policy ON projects USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY objective_project_links_tenant_policy ON objective_project_links USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY project_members_tenant_policy ON project_members USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY milestones_tenant_policy ON milestones USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tasks_tenant_policy ON tasks USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY risks_tenant_policy ON risks USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY issues_tenant_policy ON issues USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY decisions_tenant_policy ON decisions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY action_items_tenant_policy ON action_items USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;

