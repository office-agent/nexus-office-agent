BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='pi_mcp_call_audits_execution_scope_check'
      AND conrelid='pi_mcp_call_audits'::regclass
  ) THEN
    ALTER TABLE pi_mcp_call_audits
      ADD CONSTRAINT pi_mcp_call_audits_execution_scope_check
      CHECK (session_id IS NOT NULL AND run_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pi_mcp_call_audits_execution_scope
  ON pi_mcp_call_audits(tenant_id, session_id, run_id, created_at DESC);

COMMIT;
