BEGIN;

DROP INDEX IF EXISTS idx_pi_delivery_outbox_expired_lease;
ALTER TABLE pi_delivery_outbox DROP CONSTRAINT IF EXISTS pi_delivery_outbox_lease_check;
ALTER TABLE pi_delivery_outbox
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS lease_token,
  DROP COLUMN IF EXISTS lease_owner;

COMMIT;
