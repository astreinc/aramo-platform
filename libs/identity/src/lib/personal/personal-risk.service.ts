import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import type { PrismaClient } from '../../../prisma/generated/client/client.js';
import type { EventType } from '../audit/identity-audit.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PERSONAL_ALLOWED_COUNTRIES } from '../util/personal-eligibility.js';

import type { GeoEvidence } from './geo-ip.port.js';
import { SMS_VERIFICATION_PORT, smsVerificationAdapterFromEnv, type SmsVerificationPort } from './sms-verification.port.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.3–§6.6 — the Personal
// tenant's risk state and the send-time gate.
//
//   state            clear | review | restricted | closed
//   step_up_required the signup (or a young-account send check) asked for phone assurance
//   phone_verified_at phone assurance — set ONLY by a successful phone code check;
//                    clearing review NEVER sets it (correction C)
//   restricted_until with state 'restricted': a future time = temporary automatic
//                    pause (expires by itself); NULL = operator-confirmed restriction
//   step_up_cleared_by 'review' = while SMS was unavailable, an operator's review
//                    lifted the phone step (PO 2026-10-21 "Review replaces phone").
//                    phone_verified_at stays NULL: review is never phone assurance.
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
  step_up_cleared_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export type PersonalSendRefusal =
  | 'personal_review_pending'
  | 'personal_restricted'
  | 'phone_verification_required'
  | 'personal_location_not_supported';

// Where the send came from, against SIGN_PERSONAL_ALLOWED_COUNTRIES. 'unknown' =
// no database / no answer / lookup error — never read as inside or outside.
export type SendLocation = 'inside' | 'outside' | 'unknown';

export type PersonalSendVerdict =
  | { ok: true; location?: SendLocation }
  | {
      ok: false;
      reason: PersonalSendRefusal;
      location?: SendLocation;
      // Set when the refusal must also queue the account for review.
      flag_review?: 'send_location_outside' | 'send_location_unknown';
    };

/** A young account: the risk state is younger than this (location sends then go to review). */
export const SEND_LOCATION_YOUNG_ACCOUNT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function sendLocation(ip_country: string | null, allowed: readonly string[]): SendLocation {
  if (ip_country === null) return 'unknown';
  return allowed.includes(ip_country.toUpperCase()) ? 'inside' : 'outside';
}

/** Is a restriction in force at `now`? (until NULL = indefinite; a past until = an expired pause). */
export function restrictionInForce(view: Pick<TenantRiskStateView, 'state' | 'restricted_until'>, now: Date): boolean {
  return view.state === 'restricted' && (view.restricted_until === null || view.restricted_until.getTime() > now.getTime());
}

/**
 * The pure send decision for a Personal sender (§6.3 / §6.6 as amended by the
 * Architect ruling + PO decision of 2026-10-21). No state → fail closed as review pending.
 *   closed / restriction in force                 → personal_restricted
 *   review (or a review owed under a restriction) → personal_review_pending
 *   network country outside the allowed set or UNKNOWN (GeoLite2 is a risk
 *   signal, never a block by itself):
 *     account younger than 7 days, or step-up outstanding
 *                                                → personal_review_pending + flag for review
 *     otherwise                                  → ALLOWED (the caller records the signal)
 *   step-up outstanding, no phone assurance       → phone_verification_required
 * IP location alone never produces personal_location_not_supported here.
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
  const location = sendLocation(input.ip_country, input.allowed_countries ?? PERSONAL_ALLOWED_COUNTRIES());
  const stepUpOutstanding = view.step_up_required && view.phone_verified_at === null;
  if (location !== 'inside') {
    const young = input.now.getTime() - view.created_at.getTime() < SEND_LOCATION_YOUNG_ACCOUNT_DAYS * DAY_MS;
    if (young || stepUpOutstanding) {
      return { ok: false, reason: 'personal_review_pending', location, flag_review: location === 'outside' ? 'send_location_outside' : 'send_location_unknown' };
    }
  }
  if (stepUpOutstanding) return { ok: false, reason: 'phone_verification_required', location };
  return { ok: true, location };
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
  step_up_cleared_by: string | null;
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
  private readonly sms: SmsVerificationPort;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SMS_VERIFICATION_PORT) sms?: SmsVerificationPort,
  ) {
    this.sms = sms ?? smsVerificationAdapterFromEnv();
  }

  /** Is phone verification available (an SMS provider is configured)? */
  phoneVerificationAvailable(): boolean {
    return this.sms.configured;
  }

  /**
   * Would clearing this account's review also lift its phone step? Only while SMS
   * is unavailable and the step is outstanding (PO 2026-10-21 "Review replaces
   * phone"); with SMS configured the step needs a real phone code.
   */
  reviewClearsStepUp(v: Pick<TenantRiskStateView, 'step_up_required' | 'phone_verified_at'>): boolean {
    return v.step_up_required && v.phone_verified_at === null && !this.phoneVerificationAvailable();
  }

  async riskStateOf(tenant_id: string): Promise<TenantRiskStateView | null> {
    const row = await this.prisma.tenantRiskState.findUnique({ where: { tenant_id } });
    return row === null ? null : toView(row);
  }

  /** Phone assurance (§6.3) — only a successful phone code check ever sets it. */
  async phoneVerified(tenant_id: string): Promise<boolean> {
    return (await this.riskStateOf(tenant_id))?.phone_verified_at != null;
  }

  /**
   * The send-time gate for a Personal sender. Fails closed with no state row.
   * A send from outside the allowed countries or from an UNKNOWN location is
   * audited with its geo evidence (identity.personal.risk.send_location_signal) —
   * allowed, or (young account / open risk signals) flagged for review and refused.
   */
  async assertPersonalSendAllowed(
    tenant_id: string,
    input: { ip_country: string | null; now: Date; geo?: GeoEvidence; allowed_countries?: readonly string[] },
  ): Promise<PersonalSendVerdict> {
    const view = await this.riskStateOf(tenant_id);
    const verdict = evaluatePersonalSend(view, input);
    if (view === null || verdict.location === undefined || verdict.location === 'inside') return verdict;
    const geo: GeoEvidence = input.geo ?? { country: input.ip_country, looked_up_at: input.now.toISOString(), db_version: null };
    if (!verdict.ok && verdict.flag_review !== undefined) {
      await this.flagForReview(tenant_id, verdict.flag_review, input.now, { geo, location: verdict.location });
    }
    await this.prisma.$transaction(async (tx) => {
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.risk.send_location_signal',
        tenant_id,
        subject_id: tenant_id,
        actor_id: null,
        payload: {
          location: verdict.location,
          outcome: verdict.ok ? 'allowed' : verdict.flag_review !== undefined ? 'flagged_for_review' : 'refused',
          ...(verdict.ok ? {} : { refusal: verdict.reason }),
          geo,
        },
      });
    });
    return verdict;
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

  /**
   * review → clear (an operator approval). NEVER sets phone_verified_at
   * (correction C). While SMS is unavailable, it also lifts an outstanding phone
   * step (step_up_required → false, step_up_cleared_by 'review', audited as such)
   * — PO 2026-10-21 "Review replaces phone". With SMS configured the phone step
   * stays until a real phone code is verified.
   */
  async clearReview(tenant_id: string, actor_id: string, reason: string | null = null, now: Date = new Date()): Promise<TenantRiskStateView> {
    const smsAvailable = this.phoneVerificationAvailable();
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.tenantRiskState.findUnique({ where: { tenant_id } });
      if (cur === null) throw notPersonal(tenant_id);
      // A review owed under a restriction is cleared without lifting the restriction.
      const owedUnderRestriction = cur.state === 'restricted' && cur.review_pending;
      if (!owedUnderRestriction && cur.state !== 'review') throw illegal(tenant_id, cur.state, 'clear review of');
      const liftStep = cur.step_up_required && cur.phone_verified_at === null && !smsAvailable;
      const row = await tx.tenantRiskState.update({
        where: { tenant_id },
        data: {
          ...(owedUnderRestriction ? {} : { state: 'clear', restricted_until: null }),
          review_pending: false,
          reason,
          decided_by: actor_id,
          updated_at: now,
          // phone_verified_at is deliberately NOT in this update.
          ...(liftStep ? { step_up_required: false, step_up_cleared_by: 'review' } : {}),
        },
      });
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.risk.review_cleared',
        tenant_id,
        subject_id: tenant_id,
        actor_id,
        payload: {
          from: cur.state,
          to: row.state,
          reason,
          ...(owedUnderRestriction ? { restriction_kept: true } : {}),
          step_up_cleared: liftStep,
          ...(liftStep ? { step_up_cleared_by: 'review', phone_verified: false, sms_available: false } : {}),
        },
      });
      return toView(row);
    });
  }

  /** restricted / review → clear (operator reinstatement, audited with its reason). */
  async reinstate(tenant_id: string, actor_id: string, reason: string | null = null, now: Date = new Date()): Promise<TenantRiskStateView> {
    return this.transition(tenant_id, ['restricted', 'review'], 'clear', 'identity.personal.risk.reinstated', 'reinstate', actor_id, reason, now);
  }

  /**
   * Any open state → closed (sending stopped for good; existing envelopes unaffected).
   * The ONE close path: the operator (platform-admin) and the account owner (Sign
   * settings → Close account, sign-service) both call it; `evidence` lands in the
   * audit payload (e.g. { closed_by: 'owner' }).
   */
  async close(tenant_id: string, actor_id: string, reason: string | null = null, now: Date = new Date(), evidence: Record<string, unknown> = {}): Promise<TenantRiskStateView> {
    return this.transition(tenant_id, ['clear', 'review', 'restricted'], 'closed', 'identity.personal.risk.closed', 'close', actor_id, reason, now, evidence);
  }

  /**
   * Ask for phone assurance (a young-account send check). Idempotent. While SMS is
   * unavailable the step cannot be met by a phone code, so the account is also
   * routed to review (reason step_up_phone_unavailable) — an operator's review then
   * lifts it (clearReview), never recording phone assurance.
   */
  async requireStepUp(tenant_id: string, reason: string, now: Date = new Date(), evidence: Record<string, unknown> = {}): Promise<TenantRiskStateView> {
    const smsAvailable = this.phoneVerificationAvailable();
    const view = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.tenantRiskState.findUnique({ where: { tenant_id } });
      if (cur === null) throw notPersonal(tenant_id);
      if (cur.step_up_required) return toView(cur);
      const row = await tx.tenantRiskState.update({ where: { tenant_id }, data: { step_up_required: true, step_up_cleared_by: null, reason, updated_at: now } });
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.risk.step_up_required',
        tenant_id,
        subject_id: tenant_id,
        actor_id: null,
        payload: { reason, sms_available: smsAvailable, ...evidence },
      });
      return toView(row);
    });
    if (!smsAvailable && view.step_up_required && view.phone_verified_at === null) {
      return this.flagForReview(tenant_id, 'step_up_phone_unavailable', now, { step_up_reason: reason, ...evidence });
    }
    return view;
  }

  /** clear → review (queue for a human). A restricted / closed / already-reviewed account is unchanged. */
  async flagForReview(tenant_id: string, reason: string, now: Date = new Date(), evidence: Record<string, unknown> = {}): Promise<TenantRiskStateView> {
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
        payload: { from: cur.state, reason, ...evidence },
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
    evidence: Record<string, unknown> = {},
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
        payload: { ...evidence, from: cur.state, to, reason },
      });
      return toView(row);
    });
  }
}
