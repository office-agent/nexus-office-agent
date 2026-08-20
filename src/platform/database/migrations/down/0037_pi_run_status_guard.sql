BEGIN;

DROP TRIGGER IF EXISTS pi_run_status_transition_guard ON pi_run_manifests;
DROP FUNCTION IF EXISTS nexus_pi_run_status_transition_guard();

COMMIT;
