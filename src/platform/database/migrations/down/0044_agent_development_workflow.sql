BEGIN;
DROP TABLE IF EXISTS agent_development_deliveries;
DROP TABLE IF EXISTS agent_development_tests;
DROP TABLE IF EXISTS agent_development_versions;
DROP TABLE IF EXISTS agent_development_documents;
DROP TABLE IF EXISTS agent_development_projects;
DELETE FROM permissions WHERE code IN ('agent_development:read','agent_development:write','agent_development:deliver');
COMMIT;
