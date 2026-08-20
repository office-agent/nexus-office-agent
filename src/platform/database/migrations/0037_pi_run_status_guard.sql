BEGIN;

CREATE OR REPLACE FUNCTION nexus_pi_run_status_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_status = OLD.run_status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.run_status = 'queued' AND NEW.run_status IN ('provisioning','running','awaiting_approval','cancelling','cancelled','failed','timed_out','unknown')) OR
    (OLD.run_status = 'provisioning' AND NEW.run_status IN ('running','awaiting_approval','completed','cancelling','cancelled','failed','timed_out','queued','unknown')) OR
    (OLD.run_status = 'running' AND NEW.run_status IN ('awaiting_approval','completed','cancelling','cancelled','failed','timed_out','queued','unknown')) OR
    (OLD.run_status = 'awaiting_approval' AND NEW.run_status IN ('cancelling','cancelled','unknown')) OR
    (OLD.run_status = 'cancelling' AND NEW.run_status IN ('cancelled','unknown'))
  ) THEN
    RAISE EXCEPTION 'PI_RUN_STATUS_TRANSITION_INVALID:%->%', OLD.run_status, NEW.run_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER pi_run_status_transition_guard
  BEFORE UPDATE OF run_status ON pi_run_manifests
  FOR EACH ROW EXECUTE FUNCTION nexus_pi_run_status_transition_guard();

COMMIT;
