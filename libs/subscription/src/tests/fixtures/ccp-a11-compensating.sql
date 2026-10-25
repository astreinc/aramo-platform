-- CCP-A11 — the compensating migration for the pre-CCP grant record backfill
-- (doc/ccp/slices/CCP-A11-acceptance.md §6). The backfill writes ONLY append-only
-- subscription."CommercialAuditEvent" rows (COMMERCIAL_PRE_CCP_GRANT_RECORDED); the stream
-- rejects UPDATE and DELETE, so compensation APPENDS one COMMERCIAL_PRE_CCP_GRANT_RECORD_WITHDRAWN
-- event per record and deletes nothing. No subscription, pin, entitlement or usage row is touched
-- (none was written). Idempotent (deterministic ids, ON CONFLICT DO NOTHING).
-- Executed by the CCP-A11 fixture spec only. Running it against production needs separate PO
-- authorization (PBD §7.5, A0-C15), exactly like the backfill it compensates.
DO $$
BEGIN
  IF (SELECT count(*) FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'CCP-A11 compensation refused: there is not exactly one ACTIVE commercial policy version';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription."CommercialAuditEvent" e
              WHERE e.event_type = 'COMMERCIAL_PRE_CCP_GRANT_RECORDED'
                AND (e.change_request_id IS NOT NULL OR e.actor_type <> 'system' OR e.correlation_id NOT LIKE 'ccp-a11-backfill:%')) THEN
    RAISE EXCEPTION 'CCP-A11 compensation refused: a pre-CCP record not written by the CCP-A11 backfill exists';
  END IF;
END $$;

INSERT INTO subscription."CommercialAuditEvent"
  (id, actor_id, actor_type, actor_role_keys, event_type, is_exception, tenant_id, subject, change_request_id, policy_version_id, payload, correlation_id)
SELECT md5('ccp-a11:withdraw:' || e.id::text)::uuid, NULL, 'system', '{}', 'COMMERCIAL_PRE_CCP_GRANT_RECORD_WITHDRAWN', false, e.tenant_id, e.subject, NULL,
       (SELECT p.id FROM subscription."CommercialPolicyVersion" p WHERE p.status = 'ACTIVE'),
       jsonb_build_object('backfill', 'CCP-A11', 'record_kind', 'PRE_CCP_MANUAL_GRANT', 'withdraws_event_id', e.id::text),
       'ccp-a11-compensation:' || e.id::text
  FROM subscription."CommercialAuditEvent" e
 WHERE e.event_type = 'COMMERCIAL_PRE_CCP_GRANT_RECORDED'
 ORDER BY e.id
ON CONFLICT (id) DO NOTHING;
