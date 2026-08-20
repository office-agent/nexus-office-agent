BEGIN;

INSERT INTO permissions(id,code,description,risk_level) VALUES
  ('52000000-0000-4000-8000-000000000003','wecom_message:send','Confirm and send a direct message through the tenant WeCom application',3)
ON CONFLICT (code) DO UPDATE SET
  description=EXCLUDED.description,
  risk_level=EXCLUDED.risk_level;

COMMIT;
