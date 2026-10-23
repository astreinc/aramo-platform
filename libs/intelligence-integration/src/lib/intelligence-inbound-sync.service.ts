import { Injectable, Logger } from '@nestjs/common';
import { EntitlementRepository } from '@aramo/entitlement';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import {
  TalentIntelligenceRepository,
  TalentRecordReconcileRepository,
  intelligenceReferenceId,
  type InboundEventRow,
  type IntelligenceWritableColumn,
} from '@aramo/talent-record';

import { IntelligenceClient, IntelligenceRejectedError, IntelligenceUnavailableError } from './intelligence-client.js';
import {
  decideField,
  effectiveMode,
  proposalsFromProfile,
  type FieldControl,
  type FieldDecision,
} from './sync-policy.js';

// ATI-SEP-1 T8 (ADR-0036 §3 "TI → ATS") — the INBOUND SYNC. The webhook receiver
// only verifies + records the delivery (inbox); this service, run by the worker,
// drains the inbox under a lease:
//
//   1. not configured / tenant not entitled / record gone → SKIPPED (outcome);
//   2. GET /v1/references/ARAMO_ATS/{tenant}/{talent}/profile (TI decides what
//      this tenant may see — TENANT_SCOPED by default);
//   3. upsert intelligence_link (tenant, talent) → Golden subject;
//   4. per field key: the tenant's policy (defaults: availability AUTO_APPLY,
//      contacts IGNORE, everything else REVIEW) and the decision matrix —
//      AUTO_APPLY only into an empty or machine-sourced field (provenance
//      INTELLIGENCE), REVIEW as an INTELLIGENCE contradiction + PENDING_REVIEW,
//      never over a recruiter-confirmed value.
//
// TI unavailable → the row stays RECEIVED with a backoff lease, then QUARANTINED
// after INBOUND_MAX_ATTEMPTS. A 403 / 404 read refusal (unentitled in TI, reference
// erased / unknown) is final → SKIPPED. Idempotent: an AUTO_APPLY of a value
// already present is no change, and a REVIEW of the same proposal is keyed by a
// deterministic reference id (subject, field, value).

export const INBOUND_MAX_ATTEMPTS = 10;
const INBOUND_LEASE_SECONDS = 120;
const INBOUND_BATCH = 25;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 900_000;

export interface InboundSyncResult {
  status: 'APPLIED' | 'SKIPPED' | 'RETRY' | 'QUARANTINED';
  outcome: string;
  applied: number;
  review: number;
  ignored: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class IntelligenceInboundSyncService {
  private readonly logger = new Logger('IntelligenceInboundSync');

  constructor(
    private readonly client: IntelligenceClient,
    private readonly entitlements: EntitlementRepository,
    private readonly records: TalentIntelligenceRepository,
    private readonly reconcile: TalentRecordReconcileRepository,
    private readonly evidence: TalentEvidenceRepository,
  ) {}

  /** One drain pass. Returns the per-row results (tests / logs). */
  async drainOnce(now: Date = new Date()): Promise<InboundSyncResult[]> {
    const rows = await this.records.claimInboundEvents({ limit: INBOUND_BATCH, lease_seconds: INBOUND_LEASE_SECONDS, now });
    const results: InboundSyncResult[] = [];
    for (const row of rows) results.push(await this.process(row, now));
    return results;
  }

  async process(row: InboundEventRow, now: Date = new Date()): Promise<InboundSyncResult> {
    try {
      const result = await this.apply(row, now);
      await this.records.completeInboundEvent({ event_id: row.event_id, status: result.status === 'APPLIED' ? 'APPLIED' : 'SKIPPED', outcome: result.outcome, now });
      this.log(row, result);
      return result;
    } catch (err) {
      const retryable = err instanceof IntelligenceUnavailableError;
      if (!retryable || row.attempts >= INBOUND_MAX_ATTEMPTS) {
        const result: InboundSyncResult = { status: 'QUARANTINED', outcome: retryable ? 'TI_UNAVAILABLE' : 'FAILED', applied: 0, review: 0, ignored: 0 };
        await this.records.completeInboundEvent({ event_id: row.event_id, status: 'QUARANTINED', outcome: result.outcome, error: (err as Error).message.slice(0, 500), now });
        this.logger.error({ event: 'intelligence_inbound_quarantined', event_id: row.event_id, tenant_id: row.tenant_id, reason: (err as Error).message });
        return result;
      }
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, row.attempts - 1));
      await this.records.retryInboundEventLater({ event_id: row.event_id, error: (err as Error).message, retry_at: new Date(now.getTime() + delay) });
      this.logger.warn({ event: 'intelligence_inbound_retry', event_id: row.event_id, tenant_id: row.tenant_id, attempts: row.attempts, retry_in_ms: delay });
      return { status: 'RETRY', outcome: 'TI_UNAVAILABLE', applied: 0, review: 0, ignored: 0 };
    }
  }

  private async apply(row: InboundEventRow, now: Date): Promise<InboundSyncResult> {
    const skipped = (outcome: string): InboundSyncResult => ({ status: 'SKIPPED', outcome, applied: 0, review: 0, ignored: 0 });
    if (!this.client.configured) return skipped('TI_NOT_CONFIGURED');
    if (!UUID.test(row.tenant_id) || !UUID.test(row.talent_record_id)) return skipped('INVALID_REFERENCE');
    const capabilities = await this.entitlements.getCapabilities(row.tenant_id);
    if (!capabilities.has('intelligence')) return skipped('NOT_ENTITLED');
    const record = await this.records.readAdmissibleRecord({ tenant_id: row.tenant_id, id: row.talent_record_id });
    if (record === null) return skipped('TALENT_NOT_FOUND');

    let profile;
    try {
      profile = await this.client.readProfile({ tenant_id: row.tenant_id, talent_id: row.talent_record_id });
    } catch (err) {
      if (err instanceof IntelligenceRejectedError && (err.status === 403 || err.status === 404)) return skipped(`READ_REFUSED_${err.code}`);
      throw err;
    }
    await this.records.upsertLink({
      tenant_id: row.tenant_id,
      talent_record_id: row.talent_record_id,
      intelligence_subject_id: profile.intelligence_subject_id,
      synced_at: now,
    });

    const [values, policy, states, evidence] = await Promise.all([
      this.records.readWritableValues({ tenant_id: row.tenant_id, talent_record_id: row.talent_record_id }),
      this.records.listSyncPolicy(row.tenant_id),
      this.reconcile.listProfileFieldStates(row.talent_record_id),
      this.evidence.readEvidenceForIntelligence({ tenant_id: row.tenant_id, talent_id: row.talent_record_id }),
    ]);
    if (values === null) return skipped('TALENT_NOT_FOUND');
    const controls = new Map<string, FieldControl>(states.map((s) => [s.field_key, s as FieldControl]));
    const proposals = proposalsFromProfile(profile, {
      values,
      email2: record.email2,
      phones: [record.phone_cell, record.phone_home, record.phone_work].filter((p): p is string => p !== null),
      work_authorization: record.work_authorization,
      skill_names: evidence.skills.map((s) => s.surface_form),
      employer_names: evidence.work_history.map((w) => w.employer_name),
      institution_names: evidence.education.map((e) => e.institution_name),
      certification_names: evidence.certifications.map((c) => c.certification_name),
      project_names: evidence.projects.map((p) => p.project_name).filter((n): n is string => n !== null),
    });

    let applied = 0;
    let review = 0;
    let ignored = 0;
    for (const p of proposals) {
      const mode = effectiveMode(p.field_key, policy.get(p.field_key));
      const columns = Object.keys(p.columns) as IntelligenceWritableColumn[];
      const decision: FieldDecision = decideField({
        mode,
        ats_empty: p.ats_empty,
        controls: (columns.length > 0 ? columns : [p.field_name]).map((c) => controls.get(c)),
        writable: columns.length > 0,
      });
      const reference_id = intelligenceReferenceId([profile.intelligence_subject_id, p.field_key, p.field_name, p.display]);
      if (decision === 'IGNORE') {
        ignored++;
      } else if (decision === 'APPLY') {
        await this.records.applyIntelligenceField({ tenant_id: row.tenant_id, talent_record_id: row.talent_record_id, columns: p.columns, reference_id });
        applied++;
      } else {
        if (
          await this.records.recordIntelligenceReview({
            tenant_id: row.tenant_id,
            talent_record_id: row.talent_record_id,
            field_key: p.field_name,
            proposed_value: p.display,
            reference_id,
          })
        ) {
          review++;
        }
      }
    }
    return { status: 'APPLIED', outcome: `applied=${applied} review=${review} ignored=${ignored}`, applied, review, ignored };
  }

  private log(row: InboundEventRow, r: InboundSyncResult): void {
    this.logger.log({
      event: 'intelligence_inbound_sync',
      event_id: row.event_id,
      tenant_id: row.tenant_id,
      talent_record_id: row.talent_record_id,
      status: r.status,
      outcome: r.outcome,
    });
  }
}

