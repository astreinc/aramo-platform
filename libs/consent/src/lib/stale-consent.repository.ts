import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// M5 PR-11 §4.2 — stale-consent job repository.
//
// Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6 binding.
// ADR-0018 Decision 5 codifies stale-consent action='expired' insertion.
//
// SEPARATE REPOSITORY (not extension of ConsentRepository) because:
// (1) ConsentRepository is bounded by the R4 two-category guardrail
//     (consent.refusal-r4.spec.ts): write region permits 6 specific
//     operations, resolver region permits 5 specific operations. The
//     stale-consent job is a THIRD category (job-path reader + writer)
//     that doesn't fit either constraint cleanly.
// (2) Keeping the job-path code in its own file makes the R4 guardrail's
//     classification explicit: ConsentRepository = check/grant/revoke
//     surfaces; StaleConsentRepository = scheduled-job surface.
// (3) Future M6/M7 work that adds remediation or scope-expansion logic
//     extends this file rather than churning consent.repository.ts.
//
// findStaleContactingGrants returns latest-contacting-grant rows whose
// occurred_at is older than the 12-month staleness window AND whose
// latest event for the same (tenant_id, talent_record_id, scope='contacting')
// is still 'granted' (not already revoked or expired).
//
// markExpired inserts a new TalentConsentEvent row with action='expired'
// plus paired ConsentAuditEvent + OutboxEvent in the same transaction
// (mirrors PR-2 grant/revoke transaction boundary; precedent #6).

export interface StaleContactingGrant {
  tenant_id: string;
  talent_record_id: string;
  latest_grant_event_id: string;
  latest_grant_occurred_at: Date;
}

export interface MarkExpiredInput {
  tenant_id: string;
  talent_record_id: string;
  // PR-11 ships staleness only for the contacting scope (Decision F precedent).
  // The parameter is closed-typed to make any future scope expansion an
  // explicit type-change rather than a runtime surprise.
  scope: 'contacting';
  occurred_at: Date;
  // Free-form auditing reason; written into ConsentAuditEvent.event_payload
  // for forensic traceability. Conventional value at PR-11:
  // 'stale_consent_12mo_window'.
  reason: string;
}

@Injectable()
export class StaleConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Scan: returns latest contacting-scope grants whose occurred_at is
   * older than `cutoff` AND whose latest event for (tenant_id, talent_record_id,
   * scope) is still `granted`. The "latest event is still granted" check
   * is performed in-memory after a single bounded findMany — same
   * pattern as the resolver-path readers.
   */
  async findStaleContactingGrants(input: {
    cutoff: Date;
    computedAt: Date;
  }): Promise<StaleContactingGrant[]> {
    const events = await this.prisma.talentConsentEvent.findMany({
      where: { scope: 'contacting' },
      orderBy: [
        { tenant_id: 'asc' },
        { talent_record_id: 'asc' },
        { occurred_at: 'desc' },
      ],
    });

    // Partition by (tenant_id, talent_record_id) and take the latest event per
    // partition. A latest event with action='granted' AND occurred_at <
    // cutoff yields a stale-consent result row.
    const latestByTalent = new Map<string, typeof events[number]>();
    for (const ev of events) {
      const key = `${ev.tenant_id}:${ev.talent_record_id}`;
      if (!latestByTalent.has(key)) {
        latestByTalent.set(key, ev);
      }
    }

    const stale: StaleContactingGrant[] = [];
    for (const ev of latestByTalent.values()) {
      if (ev.action !== 'granted') continue;
      if (ev.occurred_at.getTime() >= input.cutoff.getTime()) continue;
      stale.push({
        tenant_id: ev.tenant_id,
        talent_record_id: ev.talent_record_id,
        latest_grant_event_id: ev.id,
        latest_grant_occurred_at: ev.occurred_at,
      });
    }
    return stale;
  }

  /**
   * Writer: inserts TalentConsentEvent action='expired' + ConsentAuditEvent
   * 'consent.expired.recorded' + OutboxEvent 'consent.expired' in one tx.
   *
   * TalentConsentEvent.action enum reserves 'expired' per PR-2
   * (libs/consent/prisma/schema.prisma:38-40 design marker; PL-86
   * substrate pre-states the enum value).
   */
  async markExpired(input: MarkExpiredInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const eventId = uuidv7();

      // 1. Insert TalentConsentEvent with action='expired'.
      await tx.talentConsentEvent.create({
        data: {
          id: eventId,
          tenant_id: input.tenant_id,
          talent_record_id: input.talent_record_id,
          scope: input.scope,
          action: 'expired',
          captured_by_actor_id: null,
          // No closed-enum 'system' value in captured_method (Group 2 §2.2
          // 4 values: self_signup | recruiter_capture | upload_flow | import).
          // The action='expired' discriminant + audit event_type are the
          // canonical system-origin signals; captured_method is set to
          // 'self_signup' as the most-permissive closed-enum value (no
          // actor_id; PR-2 precedent for self-signup nullable actor).
          captured_method: 'self_signup',
          consent_version: '1',
          consent_text_snapshot: null,
          consent_document_id: null,
          occurred_at: input.occurred_at,
          expires_at: null,
          metadata: { reason: input.reason } as never,
        },
      });

      // 2. Insert ConsentAuditEvent. event_type 'consent.expired.recorded'
      //    parallels 'consent.grant.recorded' + 'consent.revoke.recorded'.
      await tx.consentAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          actor_id: null,
          actor_type: 'system',
          event_type: 'consent.expired.recorded',
          subject_id: input.talent_record_id,
          event_payload: {
            event_id: eventId,
            scope: input.scope,
            reason: input.reason,
          } as never,
        },
      });

      // 3. Insert OutboxEvent so the outbox-publisher job (§4.3) can
      //    propagate the expiration downstream (M6/M7 SNS dispatch).
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'consent.expired',
          event_payload: {
            event_id: eventId,
            talent_record_id: input.talent_record_id,
            scope: input.scope,
            reason: input.reason,
          } as never,
        },
      });
    });
  }
}
