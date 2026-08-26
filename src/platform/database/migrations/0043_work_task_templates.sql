BEGIN;

ALTER TABLE work_missions
  ADD COLUMN is_template boolean NOT NULL DEFAULT false,
  ADD COLUMN missing_fields jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(missing_fields)='array');

ALTER TABLE work_packages
  ADD COLUMN is_template boolean NOT NULL DEFAULT false,
  ADD COLUMN missing_fields jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(missing_fields)='array');

CREATE INDEX idx_work_packages_templates ON work_packages(tenant_id,published_by,updated_at DESC) WHERE is_template=true;

COMMIT;
