BEGIN;

INSERT INTO permissions(id,code,description,risk_level) VALUES
  ('52000000-0000-4000-8000-000000000001','wecom_app:read','Read the tenant WeCom application configuration and permission boundaries',1),
  ('52000000-0000-4000-8000-000000000002','wecom_app:admin','Propose and confirm changes to the tenant WeCom application configuration',3)
ON CONFLICT (code) DO UPDATE SET
  description=EXCLUDED.description,
  risk_level=EXCLUDED.risk_level;

COMMIT;
