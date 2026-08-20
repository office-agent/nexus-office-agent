BEGIN;

CREATE TABLE management_cadences (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  cadence_type text NOT NULL CHECK (cadence_type IN ('weekly_operations','monthly_business','quarterly_strategy','custom')),
  frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly','quarterly')),
  timezone text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  participant_role_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(participant_role_ids) = 'array'),
  agenda_template jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(agenda_template) = 'array'),
  evidence_requirements jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_requirements) = 'array'),
  status text NOT NULL CHECK (status IN ('active','paused','archived')),
  next_occurrence_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE cadence_occurrences (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  cadence_id uuid NOT NULL REFERENCES management_cadences(id),
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','preparing','ready','in_progress','awaiting_evidence','closed','cancelled')),
  briefing jsonb CHECK (briefing IS NULL OR jsonb_typeof(briefing) = 'object'),
  outcome_evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(outcome_evidence_refs) = 'array'),
  acknowledged_by_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acknowledged_by_ids) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end_at > scheduled_start_at),
  CHECK (status <> 'closed' OR jsonb_array_length(outcome_evidence_refs) > 0),
  UNIQUE (tenant_id, cadence_id, scheduled_start_at)
);

CREATE TABLE metric_semantic_profiles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  metric_id uuid NOT NULL REFERENCES metric_definitions(id),
  business_definition text NOT NULL CHECK (length(btrim(business_definition)) > 0),
  formula text NOT NULL CHECK (length(btrim(formula)) > 0),
  owner_id uuid NOT NULL REFERENCES users(id),
  steward_id uuid NOT NULL REFERENCES users(id),
  authoritative_source text NOT NULL,
  source_locator text NOT NULL,
  refresh_cadence text NOT NULL CHECK (refresh_cadence IN ('realtime','daily','weekly','monthly','quarterly')),
  freshness_sla_minutes integer NOT NULL CHECK (freshness_sla_minutes > 0),
  dimensions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dimensions) = 'array'),
  allowed_uses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_uses) = 'array'),
  prohibited_uses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(prohibited_uses) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, metric_id)
);

CREATE TABLE metric_quality_checks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  metric_id uuid NOT NULL REFERENCES metric_definitions(id),
  status text NOT NULL CHECK (status IN ('missing','stale','unverified','healthy')),
  observed_at timestamptz,
  freshness_minutes integer CHECK (freshness_minutes IS NULL OR freshness_minutes >= 0),
  completeness_percent numeric NOT NULL CHECK (completeness_percent BETWEEN 0 AND 100),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  checked_by uuid NOT NULL REFERENCES users(id),
  checked_at timestamptz NOT NULL
);

CREATE TABLE portfolio_scenarios (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  portfolio_id uuid NOT NULL REFERENCES portfolios(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assumptions) = 'array'),
  project_decisions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(project_decisions) = 'array'),
  expected_benefit numeric NOT NULL,
  estimated_cost numeric NOT NULL CHECK (estimated_cost >= 0),
  risk_score numeric NOT NULL CHECK (risk_score BETWEEN 1 AND 25),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  status text NOT NULL CHECK (status IN ('draft','recommended','selected','rejected','superseded')),
  created_by uuid NOT NULL REFERENCES users(id),
  selected_by uuid REFERENCES users(id),
  selected_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'selected' AND selected_by IS NOT NULL AND selected_at IS NOT NULL) OR status <> 'selected'),
  UNIQUE (tenant_id, portfolio_id, name)
);

CREATE UNIQUE INDEX ux_portfolio_scenarios_selected
  ON portfolio_scenarios(tenant_id, portfolio_id) WHERE status = 'selected';

CREATE TABLE enterprise_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  case_type text NOT NULL CHECK (case_type IN ('operational_exception','customer_issue','compliance','quality','service_request','other')),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL CHECK (status IN ('open','triaged','in_progress','awaiting_evidence','resolved','closed','cancelled')),
  owner_id uuid REFERENCES users(id),
  due_at timestamptz NOT NULL,
  sla_minutes integer NOT NULL CHECK (sla_minutes > 0),
  source_type text NOT NULL CHECK (source_type IN ('web','wecom','system','integration')),
  source_ref text NOT NULL,
  related_object_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(related_object_refs) = 'array'),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  created_by uuid NOT NULL REFERENCES users(id),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('in_progress','resolved','closed') OR owner_id IS NOT NULL),
  CHECK (status NOT IN ('resolved','closed') OR jsonb_array_length(evidence_refs) > 0),
  UNIQUE (tenant_id, code)
);

CREATE TABLE ai_governance_evaluations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  capability_id text NOT NULL,
  agent_run_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  dataset_ref text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('passed','failed','unknown')),
  scores jsonb NOT NULL CHECK (
    jsonb_typeof(scores) = 'object' AND
    scores ?& ARRAY['groundedness','citationCorrectness','policyCorrectness','taskCompletion'] AND
    jsonb_typeof(scores->'groundedness') = 'number' AND
    jsonb_typeof(scores->'citationCorrectness') = 'number' AND
    jsonb_typeof(scores->'policyCorrectness') = 'number' AND
    jsonb_typeof(scores->'taskCompletion') = 'number'
  ),
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  cost_microunits integer NOT NULL CHECK (cost_microunits >= 0),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  evaluated_by uuid NOT NULL REFERENCES users(id),
  evaluated_at timestamptz NOT NULL,
  CHECK (
    (scores->>'groundedness')::numeric BETWEEN 0 AND 1 AND
    (scores->>'citationCorrectness')::numeric BETWEEN 0 AND 1 AND
    (scores->>'policyCorrectness')::numeric BETWEEN 0 AND 1 AND
    (scores->>'taskCompletion')::numeric BETWEEN 0 AND 1
  )
);

CREATE TABLE management_channel_actions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  action_type text NOT NULL CHECK (action_type IN ('case_accept','cadence_start')),
  resource_type text NOT NULL CHECK (resource_type IN ('enterprise_case','cadence_occurrence')),
  resource_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version > 0),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','executed','expired','cancelled','failed')),
  connection_id uuid NOT NULL REFERENCES connections(id),
  recipient_digest text NOT NULL CHECK (recipient_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  executed_by uuid REFERENCES users(id),
  executed_at timestamptz,
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((status = 'executed' AND executed_by IS NOT NULL AND executed_at IS NOT NULL AND result_digest IS NOT NULL) OR status <> 'executed'),
  UNIQUE (tenant_id, proposal_hash)
);

CREATE INDEX idx_management_cadences_next ON management_cadences(tenant_id, status, next_occurrence_at);
CREATE INDEX idx_cadence_occurrences_state ON cadence_occurrences(tenant_id, status, scheduled_start_at);
CREATE INDEX idx_metric_quality_latest ON metric_quality_checks(tenant_id, metric_id, checked_at DESC);
CREATE INDEX idx_portfolio_scenarios_portfolio ON portfolio_scenarios(tenant_id, portfolio_id, updated_at DESC);
CREATE INDEX idx_enterprise_cases_attention ON enterprise_cases(tenant_id, status, severity, due_at);
CREATE INDEX idx_ai_governance_capability ON ai_governance_evaluations(tenant_id, capability_id, evaluated_at DESC);
CREATE INDEX idx_management_channel_actions_pending ON management_channel_actions(tenant_id, status, expires_at);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'management_cadences','cadence_occurrences','metric_semantic_profiles','metric_quality_checks',
    'portfolio_scenarios','enterprise_cases','ai_governance_evaluations','management_channel_actions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_select_policy', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_insert_policy', table_name);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name || '_tenant_update_policy', table_name);
    EXECUTE format('CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change()', table_name);
  END LOOP;
END;
$$;

COMMIT;
