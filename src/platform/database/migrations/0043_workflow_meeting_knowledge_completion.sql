BEGIN;

ALTER TABLE meeting_records
  ADD CONSTRAINT meeting_records_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS source_meeting_id uuid,
  ADD CONSTRAINT decisions_source_meeting_tenant_fk
    FOREIGN KEY (tenant_id, source_meeting_id)
    REFERENCES meeting_records(tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_decisions_source_meeting
  ON decisions(tenant_id, source_meeting_id)
  WHERE source_meeting_id IS NOT NULL;

COMMIT;
