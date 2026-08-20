BEGIN;

ALTER TABLE pi_delivery_outbox
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Rows leased by the pre-fencing implementation have no verifiable owner. They
-- are intentionally terminalized instead of replayed during the upgrade.
UPDATE pi_delivery_outbox
SET status = 'unknown',
    last_error_code = 'PI_CHANGE_LEASE_UPGRADE_REQUIRED',
    updated_at = now()
WHERE status = 'leased'
  AND (lease_owner IS NULL OR lease_token IS NULL OR lease_expires_at IS NULL);

ALTER TABLE pi_delivery_outbox
  DROP CONSTRAINT IF EXISTS pi_delivery_outbox_lease_check;

ALTER TABLE pi_delivery_outbox
  ADD CONSTRAINT pi_delivery_outbox_lease_check CHECK (
    status <> 'leased'
    OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_pi_delivery_outbox_expired_lease
  ON pi_delivery_outbox(tenant_id, lease_expires_at, created_at)
  WHERE status = 'leased';

COMMIT;
