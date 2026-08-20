BEGIN;

CREATE TABLE strategy_themes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('draft','active','completed','cancelled')),
  starts_at date NOT NULL,
  ends_at date NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at)
);

CREATE TABLE metric_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id uuid NOT NULL REFERENCES users(id),
  unit text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('increase','decrease','maintain')),
  baseline numeric NOT NULL,
  target_value numeric NOT NULL,
  tolerance_percent numeric NOT NULL DEFAULT 0 CHECK (tolerance_percent BETWEEN 0 AND 100),
  source_system text NOT NULL,
  source_locator text NOT NULL,
  refresh_cadence text NOT NULL CHECK (refresh_cadence IN ('daily','weekly','monthly','quarterly')),
  classification text NOT NULL CHECK (classification IN ('internal','confidential')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE objective_governance_profiles (
  objective_id uuid PRIMARY KEY REFERENCES objectives(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  theme_id uuid NOT NULL REFERENCES strategy_themes(id),
  objective_type text NOT NULL CHECK (objective_type IN ('okr','kpi')),
  measurement_method text NOT NULL,
  data_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE objective_metric_links (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  objective_id uuid NOT NULL REFERENCES objectives(id),
  metric_id uuid NOT NULL REFERENCES metric_definitions(id),
  weight numeric NOT NULL DEFAULT 1 CHECK (weight > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, objective_id, metric_id)
);

ALTER TABLE key_results ADD COLUMN metric_id uuid REFERENCES metric_definitions(id);
ALTER TABLE key_results ADD COLUMN evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE metric_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  metric_id uuid NOT NULL REFERENCES metric_definitions(id),
  value numeric NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  observed_at timestamptz NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('authoritative','human_confirmed')),
  source_ref text NOT NULL,
  evidence_refs jsonb NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) > 0),
  UNIQUE (tenant_id, metric_id, period_start, period_end, source_ref)
);

CREATE TABLE portfolios (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('draft','active','paused','closed')),
  investment_thesis text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE portfolio_projects (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  portfolio_id uuid NOT NULL REFERENCES portfolios(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  priority integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, portfolio_id, project_id)
);

CREATE TABLE operating_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title text NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('draft','pending_confirmation','confirmed')),
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  inferences jsonb NOT NULL DEFAULT '[]'::jsonb,
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluded_data_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK ((status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL) OR status <> 'confirmed')
);

CREATE TABLE responsibility_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  resource_type text NOT NULL CHECK (resource_type IN ('objective','project','metric','process')),
  resource_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('user','position','governance_group')),
  subject_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('accountable','responsible','consulted','informed')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  UNIQUE (tenant_id, resource_type, resource_id, subject_type, subject_id, role, starts_at)
);
CREATE UNIQUE INDEX uq_responsibility_single_accountable
  ON responsibility_assignments(tenant_id, resource_type, resource_id)
  WHERE role = 'accountable' AND ends_at IS NULL;

CREATE TABLE capacity_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  available_hours numeric NOT NULL CHECK (available_hours > 0),
  allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  included_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (jsonb_typeof(allocations) = 'array'),
  UNIQUE (tenant_id, user_id, period_start, period_end)
);

CREATE TABLE performance_facts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  source_type text NOT NULL CHECK (source_type IN ('objective','project','responsibility','feedback','development')),
  source_id uuid NOT NULL,
  statement text NOT NULL,
  evidence_refs jsonb NOT NULL,
  fact_type text NOT NULL CHECK (fact_type IN ('fact','human_confirmed_feedback')),
  effective_at timestamptz NOT NULL,
  classification text NOT NULL CHECK (classification IN ('confidential','restricted')),
  visible_to_ids jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) > 0),
  CHECK (jsonb_typeof(visible_to_ids) = 'array')
);

CREATE TABLE talent_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  record_type text NOT NULL CHECK (record_type IN ('development_goal','feedback','one_to_one','talent_label')),
  content text NOT NULL,
  participant_ids jsonb NOT NULL,
  agent_eligible boolean NOT NULL DEFAULT false,
  classification text NOT NULL CHECK (classification IN ('confidential','restricted')),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(participant_ids) = 'array'),
  CHECK (record_type <> 'one_to_one' OR (agent_eligible = false AND classification = 'restricted'))
);

CREATE INDEX idx_metric_observations_latest ON metric_observations(tenant_id, metric_id, observed_at DESC);
CREATE INDEX idx_operating_reviews_period ON operating_reviews(tenant_id, period_end DESC, status);
CREATE INDEX idx_responsibility_subject ON responsibility_assignments(tenant_id, subject_id, role);
CREATE INDEX idx_capacity_period ON capacity_plans(tenant_id, period_start, period_end);
CREATE INDEX idx_performance_subject ON performance_facts(tenant_id, subject_user_id, effective_at DESC);
CREATE INDEX idx_talent_subject ON talent_records(tenant_id, subject_user_id, effective_at DESC);

ALTER TABLE strategy_themes ENABLE ROW LEVEL SECURITY; ALTER TABLE strategy_themes FORCE ROW LEVEL SECURITY;
ALTER TABLE metric_definitions ENABLE ROW LEVEL SECURITY; ALTER TABLE metric_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE objective_governance_profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE objective_governance_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE objective_metric_links ENABLE ROW LEVEL SECURITY; ALTER TABLE objective_metric_links FORCE ROW LEVEL SECURITY;
ALTER TABLE metric_observations ENABLE ROW LEVEL SECURITY; ALTER TABLE metric_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY; ALTER TABLE portfolios FORCE ROW LEVEL SECURITY;
ALTER TABLE portfolio_projects ENABLE ROW LEVEL SECURITY; ALTER TABLE portfolio_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE operating_reviews ENABLE ROW LEVEL SECURITY; ALTER TABLE operating_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE responsibility_assignments ENABLE ROW LEVEL SECURITY; ALTER TABLE responsibility_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE capacity_plans ENABLE ROW LEVEL SECURITY; ALTER TABLE capacity_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE performance_facts ENABLE ROW LEVEL SECURITY; ALTER TABLE performance_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE talent_records ENABLE ROW LEVEL SECURITY; ALTER TABLE talent_records FORCE ROW LEVEL SECURITY;

CREATE POLICY strategy_themes_tenant_policy ON strategy_themes USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY metric_definitions_tenant_policy ON metric_definitions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY objective_governance_tenant_policy ON objective_governance_profiles USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY objective_metric_links_tenant_policy ON objective_metric_links USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY metric_observations_tenant_policy ON metric_observations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY portfolios_tenant_policy ON portfolios USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY portfolio_projects_tenant_policy ON portfolio_projects USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY operating_reviews_tenant_policy ON operating_reviews USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY responsibility_assignments_tenant_policy ON responsibility_assignments USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY capacity_plans_tenant_policy ON capacity_plans USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY performance_facts_tenant_policy ON performance_facts USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY talent_records_tenant_policy ON talent_records USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
