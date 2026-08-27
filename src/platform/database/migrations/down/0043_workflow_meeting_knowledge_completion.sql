BEGIN;

DROP INDEX IF EXISTS idx_decisions_source_meeting;
ALTER TABLE decisions
  DROP CONSTRAINT IF EXISTS decisions_source_meeting_tenant_fk,
  DROP COLUMN IF EXISTS source_meeting_id;
ALTER TABLE meeting_records DROP CONSTRAINT IF EXISTS meeting_records_tenant_id_id_key;

COMMIT;
