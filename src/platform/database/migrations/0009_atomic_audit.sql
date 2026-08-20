CREATE OR REPLACE FUNCTION nexus_atomic_audit_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  row_before jsonb;
  row_after jsonb;
  tenant_value uuid;
  actor_value text;
  actor_type_value text;
  channel_value text;
  trace_value text;
  resource_value text;
BEGIN
  row_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  row_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  tenant_value := COALESCE((row_after->>'tenant_id')::uuid,(row_before->>'tenant_id')::uuid);
  actor_value := COALESCE(NULLIF(current_setting('app.actor_id',true),''),'system');
  actor_type_value := COALESCE(NULLIF(current_setting('app.actor_type',true),''),'system');
  IF actor_type_value NOT IN ('user','agent','system') THEN actor_type_value := 'system'; END IF;
  channel_value := COALESCE(NULLIF(current_setting('app.channel',true),''),'system');
  IF channel_value NOT IN ('web','feishu','dingtalk','wecom','system') THEN channel_value := 'system'; END IF;
  trace_value := COALESCE(NULLIF(current_setting('app.trace_id',true),''),'db-'||md5(clock_timestamp()::text||random()::text));
  resource_value := COALESCE(row_after->>'id',row_before->>'id',row_after->>'installation_id',row_before->>'installation_id',tenant_value::text);
  PERFORM set_config('app.tenant_id',tenant_value::text,true);
  INSERT INTO audit_events(id,occurred_at,tenant_id,actor_type,actor_id,channel,trace_id,action,resource_type,resource_id,decision,before_digest,after_digest,metadata)
  VALUES(
    md5(clock_timestamp()::text||random()::text||TG_TABLE_NAME||resource_value)::uuid,
    clock_timestamp(),tenant_value,actor_type_value,actor_value,channel_value,trace_value,
    'database.'||lower(TG_OP),TG_TABLE_NAME,resource_value,'executed',
    CASE WHEN row_before IS NULL THEN NULL ELSE md5(row_before::text) END,
    CASE WHEN row_after IS NULL THEN NULL ELSE md5(row_after::text) END,
    jsonb_build_object('source','atomic-database-trigger','schema',TG_TABLE_SCHEMA)
  );
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DO $$
DECLARE table_record record;
BEGIN
  FOR table_record IN
    SELECT DISTINCT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'audit_events'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS nexus_atomic_audit ON %I',table_record.table_name);
    EXECUTE format('CREATE TRIGGER nexus_atomic_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION nexus_atomic_audit_change()',table_record.table_name);
  END LOOP;
END;
$$;
