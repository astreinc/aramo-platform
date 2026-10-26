import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES_DEFAULT,
  CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES_DEFAULT,
  COMMERCIAL_ALERT_DEFINITIONS,
  COMMERCIAL_ALERT_TYPES,
  type DetectedCondition,
  commercialAlertThresholds,
  commercialAlertTypesOf,
  diffAlerts,
} from '../lib/observability/commercial-alert.js';
import { CommercialAlertService } from '../lib/observability/commercial-alert.service.js';
import { SubscriptionModule } from '../lib/subscription.module.js';

// CCP-D3 unit tests: the closed alert set mirrors the migration CHECK; thresholds are configuration
// with documented defaults (never a policy constant); the register diff.

// CCP-R3 re-asserts the type CHECK with ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION: the latest CHECK
// body is the R3 one (the D3 migration's original CHECK is kept verbatim in its file).
// Merge train TD-MERGE-ALERT-1: the last migration that writes the type CHECK.
const MIGRATION = resolve(__dirname, '../../prisma/migrations/20261029000100_ccp_alert_type_union/migration.sql');

const cond = (alert_type: DetectedCondition['alert_type'], subject_id: string): DetectedCondition => ({ alert_type, subject_id, tenant_id: null, product_key: null, detail: 'd', evidence: {}, threshold_minutes: null });

describe('CCP-D3 alert model', () => {
  it('D3-U-1 the closed set: 12 types in 2 families (CCP-D3 8, CCP-R3 ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION, CCP-FIX1 APPLY_DEADLINE_NEARING / APPLY_DEADLINE_PASSED, CCP-C8-PR PAYMENT_RECEIPT_UNLINKED), each pinned to one subject kind, equal to the type CHECK of the last migration that writes it (the integrator-owned alert-type union)', () => {
    expect(COMMERCIAL_ALERT_TYPES).toHaveLength(12);
    expect(commercialAlertTypesOf('BILLING')).toEqual(['COMMAND_PENDING_PROVIDER_STUCK', 'COMMAND_FAILED', 'HELD_ACTIVATION', 'WEBHOOK_INBOX_FAILED', 'USAGE_NOT_RECONCILED', 'ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION', 'PAYMENT_RECEIPT_UNLINKED']);
    expect(commercialAlertTypesOf('APPROVAL')).toEqual(['APPLY_FAILED', 'APPROVAL_NEARING_EXPIRY', 'APPROVAL_PAST_EXPIRY', 'APPLY_DEADLINE_NEARING', 'APPLY_DEADLINE_PASSED']);
    const sql = readFileSync(MIGRATION, 'utf8');
    const triples = [...sql.matchAll(/\("alert_type" = '([A-Z_]+)' AND "family" = '([A-Z]+)' AND "subject_kind" = '([a-z_]+)'\)/g)].map((m) => [m[1], m[2], m[3]]);
    expect(triples).toEqual(COMMERCIAL_ALERT_TYPES.map((t) => [t, COMMERCIAL_ALERT_DEFINITIONS[t].family, COMMERCIAL_ALERT_DEFINITIONS[t].subject_kind]));
  });

  it('D3-U-2 thresholds come from env with documented defaults; malformed, zero, negative or > 30 days fall back to the default', () => {
    expect(commercialAlertThresholds({})).toEqual({ pending_provider_stuck_minutes: 1440, approval_expiry_lead_minutes: 720 });
    expect(CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES_DEFAULT).toBe(1440);
    expect(CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES_DEFAULT).toBe(720);
    expect(commercialAlertThresholds({ CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES: '45', CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES: ' 60 ' })).toEqual({ pending_provider_stuck_minutes: 45, approval_expiry_lead_minutes: 60 });
    for (const bad of ['', 'abc', '0', '-5', '1.5', '43201', '1e3']) {
      expect(commercialAlertThresholds({ CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES: bad, CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES: bad })).toEqual({ pending_provider_stuck_minutes: 1440, approval_expiry_lead_minutes: 720 });
    }
    expect(commercialAlertThresholds({ CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES: '43200' }).pending_provider_stuck_minutes).toBe(43200);
  });

  it('D3-U-3 the register diff: new → raise, still seen → refresh, gone → resolve; a duplicate detection counts once', () => {
    const open = [
      { id: 'a1', alert_type: 'COMMAND_FAILED', subject_id: 's1' },
      { id: 'a2', alert_type: 'COMMAND_FAILED', subject_id: 's2' },
    ];
    const d = diffAlerts(open, [cond('COMMAND_FAILED', 's1'), cond('COMMAND_FAILED', 's3'), cond('COMMAND_FAILED', 's3')]);
    expect(d.raise.map((c) => c.subject_id)).toEqual(['s3']);
    expect(d.refresh.map((r) => r.open.id)).toEqual(['a1']);
    expect(d.resolve.map((a) => a.id)).toEqual(['a2']);
  });

  it('D3-U-4 the same subject under two types is two alerts (types are independent)', () => {
    const d = diffAlerts([{ id: 'n', alert_type: 'APPROVAL_NEARING_EXPIRY', subject_id: 'cr' }], [cond('APPROVAL_PAST_EXPIRY', 'cr')]);
    expect(d.raise.map((c) => c.alert_type)).toEqual(['APPROVAL_PAST_EXPIRY']);
    expect(d.resolve.map((a) => a.id)).toEqual(['n']);
  });

  it('D3-U-5 a source not read in full (unavailable or truncated) never resolves its open alerts', () => {
    const open = [
      { id: 'u', alert_type: 'USAGE_NOT_RECONCILED', subject_id: 'sign.envelopes' },
      { id: 'f', alert_type: 'COMMAND_FAILED', subject_id: 's9' },
    ];
    const d = diffAlerts(open, [], new Set(['USAGE_NOT_RECONCILED']));
    expect(d.resolve.map((a) => a.id)).toEqual(['f']);
  });

  it('D3-U-6 SubscriptionModule and forRoot() provide and export CommercialAlertService', () => {
    const meta = (k: string) => Reflect.getMetadata(k, SubscriptionModule) as unknown[];
    expect(meta('providers')).toContain(CommercialAlertService);
    expect(meta('exports')).toContain(CommercialAlertService);
    const dyn = SubscriptionModule.forRoot();
    expect(dyn.providers).toContain(CommercialAlertService);
    expect(dyn.exports).toContain(CommercialAlertService);
  });
});
