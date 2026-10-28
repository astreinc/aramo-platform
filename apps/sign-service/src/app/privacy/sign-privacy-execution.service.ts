import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  IDENTITY_RETIREMENT_PORT,
  IdentityDependencyInspector,
  PersonalRiskService,
  PrivacyRequestService,
  PrivacySubjectService,
  TenantService,
  dependencyEvidence,
  isRetiredEmailTombstone,
  privacyDeletionExecutionEnabled,
  type IdentityDependencyReport,
  type IdentityRetirementOutcome,
  type IdentityRetirementPort,
  type PrivacyActor,
  type PrivacyRequestRecord,
  type PrivacySubjectContext,
} from '@aramo/identity';
import {
  DOCUMENT_STORAGE_PORT,
  EsignSenderRepository,
  SignContactRepository,
  SignNotificationRepository,
  SignPrivacyRepository,
  SignSavedSignatureRepository,
  type DocumentStoragePort,
} from '@aramo/sign';

import { AramoSignStorageGate } from '../billing/aramo-sign-storage.gate.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.2 — executes an Aramo Sign DELETION request
// that is in EXECUTING, exactly per the §3.2 table:
//
//                 Personal account (owner)            Business member
//   Sessions      revoke every Sign device session    revoke that user's Sign sessions
//                 + Sign refresh token of the user    + Sign refresh tokens
//   Convenience   saved signatures/initials, contacts, push devices (+ jobs), feed,
//                 preferences — the member's OWN data only
//   Documents     drafts / never-sent documents       organization-owned: untouched
//                 deleted incl. stored objects;       (referred to the organization)
//                 completed agreements + evidence
//                 follow the retention rules
//   Account       risk state closed + tenant          Sign-only roles removed; the
//                 lifecycle → CLOSED (sign-in ends)   Business tenant is never touched
//   Shared        user + membership deactivated and   never retired
//   identity      the IdP user retired ONLY when no
//                 other membership / product remains
//
// Properties: the subject is re-read and must still belong to the request's tenant
// (tenant isolation); a tenant under legal hold is never executed (the request goes
// back to the queue with a LEGAL_HOLD event); every step is idempotent, so a retry
// after a partial failure completes it; completion evidence is counts only.
// The whole service refuses to run while SIGN_PRIVACY_DELETION_EXECUTION_ENABLED is
// not 1 (staged execution — production enablement needs a separate authorization).
//
// Aramo-Sign-Mobile-Amendment-M-A8 §3 replaces the Personal identity rules above:
//   - the identity-owned IdentityDependencyInspector (libs/identity) is computed at
//     execution time; (f) legal hold (tenant or any DocumentArtifact) → back to queue;
//   - no dependency ((a)–(e) clear) → FULL RETIREMENT (§3.3): sessions revoked, Sign
//     data deleted (incl. the recipient-inbox bindings), tenant OFFBOARDING → CLOSED,
//     membership + user deactivated, identity retired BY COGNITO SUB through the
//     identity-owned port (no global sign-out), then User.email tombstoned and the
//     ExternalIdentity rows removed. Signer rows and certificates are never rewritten;
//   - dependencies → RETAIN (§3.4): Sign-specific data only, the Personal Sign tenant
//     closed when (a) is clear, every other access preserved, no identity retirement,
//     and an IDENTITY_RETIREMENT_REFERRED event with the dependency codes.
// A retry after a failure at any step completes: every step is idempotent, a failed
// identity retirement throws (the request stays EXECUTING), and a user already
// tombstoned skips the identity steps.

export const PRIVACY_DELETION_REASON = 'privacy_deletion';
const SYSTEM: PrivacyActor = { actor_type: 'SYSTEM', actor_id: null };

/** §3.2 "Retained" — every category kept, with its documented justification. */
export const SIGN_RETAINED_CATEGORIES: ReadonlyArray<{ key: string; label: string; why: string }> = [
  {
    key: 'signing_evidence',
    label: 'Sent and completed agreements, their signing evidence and certificates',
    why: 'Kept under the documented retention rules so the agreements and their signatures can be proven (legal obligation and legal claims). Envelopes already sent stay open for their signers until completed, declined or expired.',
  },
  { key: 'legal_acceptances', label: 'Your acceptance of the terms and notices', why: 'Kept to show what was agreed and when (at least 6 years).' },
  { key: 'security_logs', label: 'Security and access logs', why: 'Kept for security and fraud prevention (up to 180 days).' },
  { key: 'abuse_reports', label: 'Abuse reports and their outcomes', why: 'Kept to protect recipients from abusive senders.' },
  { key: 'legal_hold', label: 'Anything under a legal hold', why: 'Kept until the hold is released; nothing is deleted while it stands.' },
  {
    key: 'account_record',
    label: 'A minimal account record (user id, sign-in email, closure date)',
    why: 'Kept with the records above so they stay attributable and so this request can be shown as completed.',
  },
  { key: 'privacy_request', label: 'This request and its history', why: 'Kept to show how the request was handled.' },
];

export const SIGN_BUSINESS_RETAINED_CATEGORY = {
  key: 'organization_documents',
  label: 'Documents your organization sent, or that you received in your role',
  why: 'They are under your organization’s authority and retention. Aramo referred your request to the organization and remains responsible for it.',
};

export type SignExecutionResult =
  | { status: 'completed'; request: PrivacyRequestRecord }
  | { status: 'held'; request: PrivacyRequestRecord }
  | { status: 'skipped'; reason: string };

@Injectable()
export class SignPrivacyExecutionService {
  private readonly log = new Logger('SignPrivacyExecution');

  constructor(
    private readonly requests: PrivacyRequestService,
    private readonly subjects: PrivacySubjectService,
    private readonly tenants: TenantService,
    private readonly risk: PersonalRiskService,
    private readonly sign: SignPrivacyRepository,
    private readonly drafts: EsignSenderRepository,
    private readonly notifications: SignNotificationRepository,
    private readonly signatures: SignSavedSignatureRepository,
    private readonly contacts: SignContactRepository,
    private readonly inspector: IdentityDependencyInspector,
    @Inject(IDENTITY_RETIREMENT_PORT) private readonly idp: IdentityRetirementPort,
    @Optional() @Inject(DOCUMENT_STORAGE_PORT) private readonly storage?: DocumentStoragePort,
    @Optional() private readonly storageGate?: AramoSignStorageGate,
  ) {}

  enabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return privacyDeletionExecutionEnabled(env);
  }

  async execute(request_id: string, now: Date = new Date()): Promise<SignExecutionResult> {
    if (!this.enabled()) return { status: 'skipped', reason: 'execution_disabled' };
    const req = await this.requests.findById(request_id);
    if (req === null) return { status: 'skipped', reason: 'not_found' };
    if (req.product !== 'SIGN' || req.request_type !== 'DELETION') return { status: 'skipped', reason: 'not_a_sign_deletion' };
    if (req.status !== 'EXECUTING') return { status: 'skipped', reason: `status_${req.status.toLowerCase()}` };
    if (req.subject_user_id === null || req.subject_tenant_id === null) {
      return { status: 'held', request: await this.backToQueue(req, 'NO_ACCOUNT_SUBJECT', { reason: 'no_account_subject' }) };
    }
    // Tenant isolation: the subject must still be a user of the request's tenant.
    const ctx = await this.subjects.context(req.subject_user_id, req.subject_tenant_id);
    if (ctx === null) return { status: 'held', request: await this.backToQueue(req, 'SUBJECT_MISMATCH', { reason: 'subject_not_in_tenant' }) };
    if (ctx.legal_hold) return { status: 'held', request: await this.backToQueue(req, 'LEGAL_HOLD', { reason: 'tenant_legal_hold' }) };
    try {
      const personalOwner = ctx.tenant_kind === 'PERSONAL' && ctx.role_keys.includes('tenant_owner');
      let evidence: Record<string, unknown>;
      let outcome_code: string;
      let outcome_text: string;
      if (personalOwner) {
        // M-A8 §3.2 — computed now, never cached.
        const report = await this.inspector.inspect(ctx.user_id, ctx.tenant_id);
        if (report.legal_hold) {
          return {
            status: 'held',
            request: await this.backToQueue(req, 'LEGAL_HOLD', { reason: report.f_legal_hold.tenant ? 'tenant_legal_hold' : 'document_legal_hold', document_artifacts: report.f_legal_hold.document_artifacts }),
          };
        }
        const alreadyRetired = !ctx.user_active && isRetiredEmailTombstone(ctx.user_id, ctx.email);
        if (alreadyRetired || report.retire_identity) {
          evidence = await this.executePersonalRetirement(ctx, report, alreadyRetired, now);
          outcome_code = 'personal_account_deleted';
          outcome_text = personalOutcomeText();
        } else {
          evidence = await this.executePersonalRetain(ctx, report, now);
          await this.requests.recordEvent(req.id, 'IDENTITY_RETIREMENT_REFERRED', SYSTEM, { dependency_codes: report.dependencies }, now);
          outcome_code = 'personal_sign_data_deleted_identity_referred';
          outcome_text = personalRetainOutcomeText(evidence);
        }
      } else {
        evidence = await this.executeMember(ctx);
        outcome_code = 'member_sign_data_removed';
        outcome_text = memberOutcomeText(evidence);
      }
      const done = await this.requests.transition(req.id, 'COMPLETED', SYSTEM, {
        now,
        from: ['EXECUTING'],
        patch: { completion_evidence: evidence, outcome_code, outcome_text },
        payload: { counts: evidence },
      });
      this.log.log(`privacy request ${req.reference} completed (${personalOwner ? 'personal' : 'member'})`);
      return { status: 'completed', request: done };
    } catch (err) {
      // Stays EXECUTING; the worker retries (every step is idempotent).
      await this.requests.recordEvent(req.id, 'EXECUTION_FAILED', SYSTEM, { error: (err as Error).name }, now).catch(() => undefined);
      this.log.warn(`privacy request ${req.reference} execution failed: ${(err as Error).name}`);
      throw err;
    }
  }

  // M-A8 §3.3 / §3.4 — the Sign-specific part, common to both Personal paths: sessions,
  // convenience data, recipient-inbox bindings, drafts / never-sent documents with their
  // stored objects. Completed agreements and their evidence are kept (retention rules).
  private async deletePersonalSignData(ctx: PrivacySubjectContext): Promise<Record<string, unknown>> {
    const owner = { tenant_id: ctx.tenant_id, user_id: ctx.user_id };
    const sessions = await this.sign.revokeSignSessions({ ...owner, reason: PRIVACY_DELETION_REASON });
    const convenience = await this.purgeConvenience(owner);
    const recipient_bindings_deleted = await this.sign.removeRecipientBindings(owner);
    // Every draft of the Personal tenant: the owner is its only sender.
    let drafts_deleted = 0;
    let draft_documents_deleted = 0;
    let stored_objects_deleted = 0;
    for (const envelope_id of await this.sign.draftEnvelopeIds(owner)) {
      const removed = await this.drafts.deleteDraft({ tenant_id: ctx.tenant_id, envelope_id, actor_ref: ctx.user_id });
      drafts_deleted += 1;
      draft_documents_deleted += removed.document_count;
      for (const key of removed.source_object_keys) {
        await this.storage?.deleteOwnedSource?.(key);
        await this.storageGate?.release(ctx.tenant_id, key).catch(() => undefined);
        stored_objects_deleted += 1;
      }
    }
    return { ...sessions, ...convenience, recipient_bindings_deleted, drafts_deleted, draft_documents_deleted, stored_objects_deleted };
  }

  /** Risk state closed (sending ends) and the tenant lifecycle CLOSED (sign-in ends). */
  private async closePersonalAccount(ctx: PrivacySubjectContext, now: Date): Promise<{ risk_closed: boolean; tenant_closed: boolean }> {
    const risk_closed = await this.closeRiskOnly(ctx, now);
    return { risk_closed, tenant_closed: await this.closeTenant(ctx, now) };
  }

  // M-A8 §3.3 — no dependency: full retirement.
  private async executePersonalRetirement(ctx: PrivacySubjectContext, report: IdentityDependencyReport, alreadyRetired: boolean, now: Date): Promise<Record<string, unknown>> {
    const data = await this.deletePersonalSignData(ctx);
    const closed = await this.closePersonalAccount(ctx, now);
    const retired = await this.subjects.retireAccountHolder(ctx.user_id, ctx.tenant_id, now);
    let idp: IdentityRetirementOutcome | 'no_cognito_subject' | 'already_retired';
    let tomb = { email_tombstoned: 0, external_identities_removed: 0 };
    if (alreadyRetired) {
      idp = 'already_retired';
    } else {
      if (report.cognito_sub === null) {
        idp = 'no_cognito_subject';
      } else {
        idp = await this.idp.retire({ cognito_sub: report.cognito_sub });
        // Only a confirmed deletion (or a pool user already gone) may drop the link that
        // names the subject; anything else stays EXECUTING and is retried.
        if (idp !== 'deleted' && idp !== 'not_found') throw Object.assign(new Error('identity retirement incomplete'), { name: 'IdentityRetirementIncomplete' });
      }
      tomb = await this.subjects.tombstoneRetiredUser(ctx.user_id, ctx.tenant_id);
    }
    return {
      path: 'personal',
      ...data,
      ...closed,
      identity_retained: false,
      memberships_deactivated: retired.memberships_deactivated,
      users_deactivated: retired.users_deactivated,
      idp_retirement: idp,
      ...tomb,
      dependencies: dependencyEvidence(report),
      retained: SIGN_RETAINED_CATEGORIES.map((c) => c.key),
    };
  }

  // M-A8 §3.4 — dependencies exist: Sign-specific data only; the Personal Sign tenant is
  // closed only when (a) is clear; every other access is preserved; no identity retirement.
  private async executePersonalRetain(ctx: PrivacySubjectContext, report: IdentityDependencyReport, now: Date): Promise<Record<string, unknown>> {
    const data = await this.deletePersonalSignData(ctx);
    const closed = report.may_close_tenant ? await this.closePersonalAccount(ctx, now) : { risk_closed: await this.closeRiskOnly(ctx, now), tenant_closed: false };
    return {
      path: 'personal',
      ...data,
      ...closed,
      identity_retained: true,
      identity_retained_because: report.dependencies,
      memberships_deactivated: 0,
      users_deactivated: 0,
      idp_retirement: 'retained',
      dependencies: dependencyEvidence(report),
      retained: SIGN_RETAINED_CATEGORIES.map((c) => c.key),
    };
  }

  /** Sending ends (Sign-specific) without closing a tenant that carries another product. */
  private async closeRiskOnly(ctx: PrivacySubjectContext, now: Date): Promise<boolean> {
    const riskState = await this.risk.riskStateOf(ctx.tenant_id);
    if (riskState === null || riskState.state === 'closed') return false;
    await this.risk.close(ctx.tenant_id, ctx.user_id, PRIVACY_DELETION_REASON, now, { closed_by: 'privacy_deletion' });
    return true;
  }

  // §3.2 Business member column.
  private async executeMember(ctx: PrivacySubjectContext): Promise<Record<string, unknown>> {
    const owner = { tenant_id: ctx.tenant_id, user_id: ctx.user_id };
    const sessions = await this.sign.revokeSignSessions({ ...owner, reason: PRIVACY_DELETION_REASON });
    const convenience = await this.purgeConvenience(owner);
    const access = await this.subjects.removeSignAccess(ctx.user_id, ctx.tenant_id);
    // Organization-wide roles (tenant_owner / tenant_admin) also carry other products and
    // stay: the organization decides those (the referral records it).
    const orgWideSignRoleRetained = access.remaining_role_keys.some((k) => k === 'tenant_owner' || k === 'tenant_admin');
    return {
      path: 'business_member',
      ...sessions,
      ...convenience,
      sign_roles_removed: access.roles_removed,
      organization_wide_role_retained: orgWideSignRoleRetained,
      tenant_closed: false,
      identity_retained: true,
      retained: [...SIGN_RETAINED_CATEGORIES.map((c) => c.key), SIGN_BUSINESS_RETAINED_CATEGORY.key],
    };
  }

  private async purgeConvenience(owner: { tenant_id: string; user_id: string }): Promise<Record<string, number>> {
    const push = await this.notifications.purgeOwner(owner, PRIVACY_DELETION_REASON);
    const saved_signatures_deleted = await this.signatures.removeAllForUser(owner.tenant_id, owner.user_id);
    const contacts_deleted = await this.contacts.removeAllForUser(owner.tenant_id, owner.user_id);
    return { ...push, saved_signatures_deleted, contacts_deleted };
  }

  private async closeTenant(ctx: PrivacySubjectContext, now: Date): Promise<boolean> {
    if (ctx.tenant_status === 'CLOSED') return false;
    const base = { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, actor_type: 'user' as const, source: 'privacy_deletion', reason_code: PRIVACY_DELETION_REASON };
    if (ctx.tenant_status === 'ACTIVE' || ctx.tenant_status === 'SUSPENDED') {
      await this.tenants.transitionTenantStatus({ ...base, to: 'OFFBOARDING', retention_policy_code: 'sign_privacy_deletion', close_at: now });
    }
    const res = await this.tenants.transitionTenantStatus({ ...base, to: 'CLOSED' });
    return res.changed;
  }

  private async backToQueue(req: PrivacyRequestRecord, event: string, payload: Record<string, unknown>): Promise<PrivacyRequestRecord> {
    await this.requests.recordEvent(req.id, event, SYSTEM, payload);
    return this.requests.transition(req.id, 'DATA_INVENTORY', SYSTEM, { from: ['EXECUTING'], payload: { returned_because: event } });
  }
}

function personalOutcomeText(): string {
  return 'Your Aramo Sign personal account is closed and its data deleted: sessions signed out, saved signatures, contacts, notifications, inbox items and drafts removed. Your Aramo sign-in has been retired. Your Google or Microsoft account itself is not affected. Records we must keep are listed with this request.';
}

function personalRetainOutcomeText(e: Record<string, unknown>): string {
  const tenant = e['tenant_closed'] === true ? 'Your Aramo Sign personal account is closed and its Sign data deleted' : 'Your Aramo Sign data is deleted';
  return `${tenant}: sessions signed out, saved signatures, contacts, notifications, inbox items and drafts removed. Your sign-in identity is kept because it is still used by another Aramo account, product or linked sign-in; our privacy team reviews it. Records we must keep are listed with this request.`;
}

function memberOutcomeText(e: Record<string, unknown>): string {
  const role = e['organization_wide_role_retained'] === true ? ' Your organization-wide role is managed by your organization.' : '';
  return `Your Aramo Sign sessions were signed out, your own Sign data (saved signatures, contacts, notifications) deleted and your Sign access removed.${role} Documents your organization sent or that you received in your role stay under your organization’s authority; we referred your request to it.`;
}
