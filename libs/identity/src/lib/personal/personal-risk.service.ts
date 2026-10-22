import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import type { PrismaClient } from '../../../prisma/generated/client/client.js';
import type { EventType } from '../audit/identity-audit.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PERSONAL_ALLOWED_COUNTRIES } from '../util/personal-eligibility.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.3–§6.6 — the Personal
// tenant's risk state and the send-time gate.
//
//   state            clear | review | restricted | closed
//   step_up_required the signup (or a young-account send check) asked for phone assurance
//   phone_verified_at phone assurance — set ONLY by a successful phone code check;
//                    clearing review NEVER sets it (correction C)
//   restricted_until with state 'restricted': a future time = temporary automatic
//                    pause (expires by itself); NULL = operator-confirmed restriction
//
// Every write inserts its IdentityAuditEvent IN THE SAME transaction (the
// DomainClaimService pattern), never through the best-effort audit service.

export const TENANT_RISK_STATES = ['clear', 'review', 'restricted', 'closed'] as const;
export type TenantRiskStateValue = (typeof TENANT_RISK_STATES)[number];

export interface TenantRiskStateView {
  tenant_id: string;
  state: TenantRiskStateValue;
  step_up_required: boolean;
  // A review still owed while a temporary restriction is in force (correction D).
  review_pending: boolean;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  restricted_until: Date | null;
  reason: string | null;
  decided_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export type PersonalSendRefusal =
  | 'personal_review_pending'
  | 'personal_restricted'
  | 'phone_verification_required'
  | 'personal_location_not_supported';

export type PersonalSendVerdict = { ok: true } | { ok: false; reason: PersonalSendRefusal };

/** Is a restriction in force at `now`? (until NULL = indefinite; a past until = an expired pause). */
export function restrictionInForce(view: Pick<TenantRiskStateView, 'state' | 'restricted_until'>, now: Date): boolean {
  return view.state === 'restricted' && (view.restricted_until === null || view.restricted_until.getTime() > now.getTime());
}

/**
 * The pure §6.3 / §6.6 send decision (no state → fail closed as review pending):
 *   closed / restriction in force            → personal_restricted
 *   review                                   → personal_review_pending
 *   step-up outstanding, no phone assurance  → phone_verification_required
 *   network country outside the allowed set
 *   (or unknown), no phone assurance         → personal_location_not_supported
 * Guest signers are never evaluated here — this gates the SENDER only.
 */
export function evaluatePersonalSend(
  view: TenantRiskStateView | null,
  input: { ip_country: string | null; now: Date; allowed_countries?: readonly string[] },
): PersonalSendVerdict {
  if (view === null) return { ok: false, reason: 'personal_review_pending' };
  if (view.state === 'closed' || restrictionInForce(view, input.now)) return { ok: false, reason: 'personal_restricted' };
  // A review owed under an expired temporary restriction still holds sending.
  if (view.state === 'review' || (view.state === 'restricted' && view.review_pending)) return { ok: false, reason: 'personal_review_pending' };
  const phoneAssured = view.phone_verified_at !== null;
  if (view.step_up_required && !phoneAssured) return { ok: false, reason: 'phone_verification_required' };
  const allowed = input.allowed_countries ?? PERSONAL_ALLOWED_COUNTRIES();
  const inAllowed = input.ip_country !== null && allowed.includes(input.ip_country.toUpperCase());
  if (!inAllowed && !phoneAssured) return { ok: false, reason: 'personal_location_not_supported' };
  return { ok: true };
}

export type RiskTx = Pick<PrismaClient, 'tenantRiskState' | 'identityAuditEvent'>;

export async function writePersonalAudit(
  tx: Pick<PrismaClient, 'identityAuditEvent'>,
  e: { event_type: EventType; tenant_id: string | null; subject_id: string; actor_id: string | null; payload: Record<string, unknown> },
): Promise<void> {
  await tx.identityAuditEvent.create({
    data: {
      id: uuidv7(),
      tenant_id: e.tenant_id,
      actor_id: e.actor_id,
      actor_type: e.actor_id === null ? 'system' : 'user',
      event_type: e.event_type,
      subject_id: e.subject_id,
      event_payload: e.payload as never,
    },
  });
}

function toView(r: {
  tenant_id: string;
  state: string;
  step_up_required: boolean;
  review_pending: boolean;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  restricted_until: Date | null;
  reason: string | null;
  decided_by: string | null;
  created_at: Date;
  updated_at: Date;
}): TenantRiskStateView {
  return { ...r, state: r.state as TenantRiskStateValue };
}

function notPersonal(tenant_id: string): AramoError {
  return new AramoError('NOT_FOUND', 'This tenant has no personal risk state', 404, {
    requestId: 'personal.risk',
    details: { tenant_id, reason: 'no_personal_risk_state' },
  });
}

function illegal(tenant_id: string, from: string, action: string): AramoError {
  return new AramoError('VALIDATION_ERROR', `Cannot ${action} a personal account in state ${from}`, 400, {
    requestId: 'personal.risk',
    details: { tenant_id, reason: 'illegal_risk_transition', from, action },
  });
}

@Injectable()
export class PersonalRiskService {
  constructor(private readonly prisma: PrismaService) {}

  async riskStateOf(tenant_id: string): Promise<TenantRiskStateView | null> {
    const row = await this.prisma.tenantRiskState.findUnique({ where: { tenant_id } });
    return row === null ? null : toView(row);
  }

  /** Phone assurance (§6.3) — only a successful phone code check ever sets it. */
  async phoneVerified(tenant_id: string): Promise<boolean> {
    return (await this.riskStateOf(tenant_id))?.phone_verified_at != null;
  }

  /** The send-time gate for a Personal sender (§6.3 / §6.6). Fails closed with no state row. */
  async assertPersonalSendAllowed(tenant_id: string, input: { ip_country: string | null; now: Date }): Promise<PersonalSendVerdict> {
    return evaluatePersonalSend(await this.riskStateOf(tenant_id), input);
  }

  /**
   * Restrict sending. `until` in the future = a temporary automatic pause (e.g.
   * weighted abuse reports, 72 h); `until` null = indefinite (operator-confirmed).
   * Never shortens a longer restriction already in force; a closed account stays closed.
   * actor_id null = the system.
   */
  async restrict(tenant_id: string, reason: string, until: Date | null, actor_id: string | null = null, now: Date = new Date()): Promise<TenantRiskStateView> {
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.tenantRiskState.findUnique({ where: { tenant_id } });
      if (cur !== null && cur.state === 'closed') return toView(cur);
      let effectiveUntil = until;
      if (cur !== null && restrictionInForce(toView(cur), now)) {
        if (cur.restricted_until === null) effectiveUntil = null;
        else if (until !== null && cur.restricted_until.getTime() > until.getTime()) effectiveUntil = cur.restricted_until;
      }
      // Keep any review that was owed: an automatic, temporary pause must not erase it.
      const review_pending = cur !== null && (cur.review_pending || cur.state === 'review');
      const data = { state: 'restricted', restricted_until: effectiveUntil, review_pending, reason, decided_by: actor_id, updated_at: now };
      const row =
        cur === null
          ? await tx.tenantRiskState.create({ data: { tenant_id, ...data, created_at: now } })
          : await tx.tenantRiskState.update({ where: { tenant_id }, data });
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.risk.restricted',
        tenant_id,
        subject_id: tenant_id,
        actor_id,
        payload: { from: cur?.state ?? null, reason, until: effectiveUntil?.toISOString() ?? null },
      });
      return toView(row);
    });
  }

  /** review → clear (an operator approval). NEVER sets phone_verified_at (correction C). */
  async clearReview(tenant_id: string, actor_id: string, reason: string | null = null, now: Date = new Date()): Promise<TenantRiskStateView> {
    // A review owed under a restriction is cleared without lifting the restriction.
    const cur = await this.prisma.tenantRiskState.findUnique({ where: { tenant_id } });
    if (cur !== null && cur.state === 'restricted' && cur.review_pending) {
      return this.prisma.$transaction(async (tx) => {
        const row = await tx.tenantRiskState.update({ where: { tenant_id }, data: { review_pending: false, reason, decided_by: actor_id, updated_at: now } });
        await writePersonalAudit(tx, { event_type: 'identity.personal.risk.review_cleared', tenant_id, subject_id: tenant_id, actor_id, payload: { from: cur.state, to: cur.state, reason, restriction_kept: true } });
        return toView(row);
      });
    }
    return this.transition(tenant_id, ['review'], 'clear', 'identity.personal.risk.review_cleared', 'clear review of', actor_id, reason, now);
  }

  /** restricted / review → clear (operator reinstatement, audited with its reason). */
  async reinstate(tenant_id: string, actor_id: string, reason: string | null = null, now: Date = new Date()): Promise<TenantRiskStateView> {
    return this.transition(tenant_id, ['restricted', 'review'], 'clear', 'identity.personal.risk.reinstated', 'reinstate', actor_id, reason, now);
  }

  /** Any open state → closed (sending stopped for good; existing envelopes unaffected). */
  async close(tenant_id: string, actor_id: string, reason: string | null = null, now: Date = new Date()): Promise<TenantRiskStateView> {
    return this.transition(tenant_id, ['clear', 'review', 'restricted'], 'closed', 'identity.personal.risk.closed', 'close', actor_id, reason, now);
  }

  /** Ask for phone assurance (a young-account send check or a signup step-up). Idempotent. */
  async requireStepUp(tenant_id: string, reason: string, now: Date = new Date()): Promise<TenantRiskStateView> {
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.tenantRiskState.findUnique({ where: { tenant_id } });
      if (cur === null) throw notPersonal(tenant_id);
      if (cur.step_up_required) return toView(cur);
      const row = await tx.tenantRiskState.update({ where: { tenant_id }, data: { step_up_required: true, reason, updated_at: now } });
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.risk.step_up_required',
        tenant_id,
        subject_id: tenant_id,
        actor_id: null,
        payload: { reason },
      });
      return toView(row);
    });
  }

  /** clear → review (queue for a human). A restricted / closed / already-reviewed account is unchanged. */
  async flagForReview(tenant_id: string, reason: string, now: Date = new Date()): Promise<TenantRiskStateView> {
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.tenantRiskState.findUnique({ where: { tenant_id } });
      if (cur === null) throw notPersonal(tenant_id);
      if (cur.state === 'review' || cur.state === 'closed' || (cur.state === 'restricted' && cur.review_pending)) return toView(cur);
      // Under a restriction the review is recorded as owed (it outlives the pause).
      const row =
        cur.state === 'restricted'
          ? await tx.tenantRiskState.update({ where: { tenant_id }, data: { review_pending: true, reason, updated_at: now } })
          : await tx.tenantRiskState.update({ where: { tenant_id }, data: { state: 'review', reason, decided_by: null, updated_at: now } });
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.risk.review_flagged',
        tenant_id,
        subject_id: tenant_id,
        actor_id: null,
        payload: { from: cur.state, reason },
      });
      return toView(row);
    });
  }

  /**
   * Record phone assurance after a successful phone code check (the ONLY path that
   * sets phone_verified_at). Satisfies an outstanding step-up.
   */
  async markPhoneVerified(tenant_id: string, phone_e164: string, now: Date = new Date()): Promise<TenantRiskStateView> {
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.tenantRiskState.findUnique({ where: { tenant_id } });
      if (cur === null) throw notPersonal(tenant_id);
      const row = await tx.tenantRiskState.update({ where: { tenant_id }, data: { phone_e164, phone_verified_at: now, updated_at: now } });
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.risk.phone_verified',
        tenant_id,
        subject_id: tenant_id,
        actor_id: null,
        payload: { step_up_satisfied: cur.step_up_required },
      });
      return toView(row);
    });
  }

  private async transition(
    tenant_id: string,
    from: readonly TenantRiskStateValue[],
    to: TenantRiskStateValue,
    event_type: EventType,
    action: string,
    actor_id: string,
    reason: string | null,
    now: Date,
  ): Promise<TenantRiskStateView> {
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.tenantRiskState.findUnique({ where: { tenant_id } });
      if (cur === null) throw notPersonal(tenant_id);
      if (!(from as readonly string[]).includes(cur.state)) throw illegal(tenant_id, cur.state, action);
      // phone_verified_at / step_up_required are deliberately NOT in this update.
      const row = await tx.tenantRiskState.update({
        where: { tenant_id },
        data: { state: to, restricted_until: null, review_pending: false, reason, decided_by: actor_id, updated_at: now },
      });
      await writePersonalAudit(tx, {
        event_type,
        tenant_id,
        subject_id: tenant_id,
        actor_id,
        payload: { from: cur.state, to, reason },
      });
      return toView(row);
    });
  }
}
