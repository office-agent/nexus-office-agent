BEGIN;

DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_delivery_events;
DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_delivery_outbox;
DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_release_proposals;
DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_merge_proposals;
DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_pull_requests;
DROP TRIGGER IF EXISTS nexus_atomic_audit ON pi_change_submissions;
DROP POLICY IF EXISTS pi_delivery_events_tenant_policy ON pi_delivery_events;
DROP POLICY IF EXISTS pi_delivery_outbox_tenant_policy ON pi_delivery_outbox;
DROP POLICY IF EXISTS pi_release_proposals_tenant_policy ON pi_release_proposals;
DROP POLICY IF EXISTS pi_merge_proposals_tenant_policy ON pi_merge_proposals;
DROP POLICY IF EXISTS pi_pull_requests_tenant_policy ON pi_pull_requests;
DROP POLICY IF EXISTS pi_change_submissions_tenant_policy ON pi_change_submissions;
DROP TABLE IF EXISTS pi_delivery_events;
DROP TABLE IF EXISTS pi_delivery_outbox;
DROP TABLE IF EXISTS pi_release_proposals;
DROP TABLE IF EXISTS pi_merge_proposals;
DROP TABLE IF EXISTS pi_pull_requests;
DROP TABLE IF EXISTS pi_change_submissions;

COMMIT;
