import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { EsignRepository, type LockingTx } from '../esign.repository.js';
import { EsignService, type SessionContext } from '../esign.service.js';
import { DEFAULT_SIGN_BASE_URL, signBaseUrl } from '../sign-base-url.js';
import { LIVE_SESSION_STATUSES } from '../domain/envelope-lifecycle.js';
import { ENVELOPE_NOTIFICATION_SERVICE, type EnvelopeNotificationService } from '../envelope-notification.service.js';

import {
  IDENTITY_VERIFICATION_PORT,
  type IdentityVerificationPort,
  IdentityVerificationUnavailableError,
} from './identity-verification.port.js';
import { KBA_PORT, type KbaPort } from './kba.port.js';
import { SIGN_ID_VERIFICATION_ATTEMPT_METER, SIGN_USAGE_RECORDER_PORT, type SignUsageRecorderPort } from './usage-recorder.port.js';
import { verifiedNameMatches } from './name-match.js';
import {
  IDENTITY_VERIFICATION_CANCELLED_EVENT,
  IDENTITY_VERIFICATION_FAILED_EVENT,
  IDENTITY_VERIFICATION_LOCKED_EVENT,
  IDENTITY_VERIFICATION_STARTED_EVENT,
  IDENTITY_VERIFIED_EVENT,
  type IdentityVerificationMethod,
  SignerIdentityVerificationLockedError,
  idVerificationMaxAttempts,
} from './identity-gate.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5…) §1.9 + Amendment A1
// (dc95b283…) — the recipient identity-verification workflow. DARK: the sender cannot set a
// method while sign.id_verification / sign.kba are NOT_AVAILABLE, and with no provider
// configured every start is refused (503).
//
//   status  → where the recipient stands (polls the vendor for a session it has not heard about)
//   start   → a vendor session; the recipient is sent to the vendor's hosted page
//   webhook → the vendor says a result is ready; the result is RE-READ from the vendor
//
// Outcomes are written once (PENDING → VERIFIED | FAILED | CANCELLED), each with a ledger
// event. Name-mismatch policy (conservative): a verified document whose name does not match
// the recipient FAILS, locks the recipient and tells the sender. A recipient who uses every
// attempt (SIGN_ID_VERIFICATION_MAX_ATTEMPTS, default 3) is locked and the sender is told.
// Each started vendor session is one metered unit (SIGN_USAGE_RECORDER_PORT).
//
// R-5: the vendor keeps the document. Aramo stores the outcome, the vendor reference, whether
// the name matched, and the issuing country. The verified name itself is never stored.

export type IdentityVerificationState = 'NOT_REQUIRED' | 'REQUIRED' | 'PENDING' | 'VERIFIED' | 'LOCKED';

export interface IdentityVerificationStatusView {
  method: IdentityVerificationMethod | null;
  state: IdentityVerificationState;
  attempts_remaining: number | null;
  /** The last attempt's failure reason (e.g. name_mismatch, document_expired), or null. */
  last_failure: string | null;
}

export interface IdentityVerificationStartView extends IdentityVerificationStatusView {
  /** The vendor's hosted page. Present only while a session is open; never stored. */
  verification_url: string | null;
}

export type IdentityWebhookOutcome = 'IGNORED' | 'UNKNOWN_SESSION' | 'PENDING' | 'ALREADY_SETTLED' | 'SETTLED';

type AttemptRow = {
  id: string;
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
  method: string;
  provider: string;
  vendor_reference: string | null;
  status: string;
  failure_reason: string | null;
  created_at: Date;
};

/** Where the vendor's hosted page returns the recipient. Carries NO token (nothing to leak to the vendor). */
export function identityVerificationReturnUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${signBaseUrl(env) ?? DEFAULT_SIGN_BASE_URL}/s/#identity-verification-done`;
}

function sanitizeFailure(code: string | null): string {
  const c = (code ?? 'unverified').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
  return c.length > 0 ? c : 'unverified';
}

@Injectable()
export class IdentityVerificationService {
  private readonly logger = new Logger('IdentityVerificationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    private readonly esign: EsignService,
    @Inject(IDENTITY_VERIFICATION_PORT) private readonly port: IdentityVerificationPort,
    @Optional() @Inject(KBA_PORT) private readonly kba?: KbaPort,
    @Optional() @Inject(SIGN_USAGE_RECORDER_PORT) private readonly usage?: SignUsageRecorderPort,
    @Optional() @Inject(ENVELOPE_NOTIFICATION_SERVICE) private readonly notifications?: EnvelopeNotificationService,
  ) {}

  private maxAttempts(): number {
    return idVerificationMaxAttempts();
  }

  private async requirement(ctx: SessionContext): Promise<{ method: IdentityVerificationMethod | null; locked: boolean; name: string }> {
    const s = await this.prisma.signer.findFirst({
      where: { id: ctx.signer_id, tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id },
      select: { identity_verification_method: true, identity_verification_locked_at: true, name: true },
    });
    return {
      method: (s?.identity_verification_method ?? null) as IdentityVerificationMethod | null,
      locked: s?.identity_verification_locked_at !== null && s?.identity_verification_locked_at !== undefined,
      name: s?.name ?? '',
    };
  }

  private attempts(ctx: SessionContext, method: string): Promise<AttemptRow[]> {
    return this.prisma.signRecipientIdentityVerification.findMany({
      where: { tenant_id: ctx.tenant_id, signer_id: ctx.signer_id, method },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
  }

  private view(method: IdentityVerificationMethod | null, locked: boolean, rows: readonly AttemptRow[]): IdentityVerificationStatusView {
    if (method === null) return { method: null, state: 'NOT_REQUIRED', attempts_remaining: null, last_failure: null };
    const started = rows.filter((r) => r.vendor_reference !== null).length;
    const remaining = Math.max(0, this.maxAttempts() - started);
    const lastFailure = rows.find((r) => r.status === 'FAILED')?.failure_reason ?? null;
    if (locked) return { method, state: 'LOCKED', attempts_remaining: 0, last_failure: lastFailure };
    if (rows.some((r) => r.status === 'VERIFIED')) return { method, state: 'VERIFIED', attempts_remaining: remaining, last_failure: null };
    if (rows.some((r) => r.status === 'PENDING' && r.vendor_reference !== null)) return { method, state: 'PENDING', attempts_remaining: remaining, last_failure: lastFailure };
    return { method, state: 'REQUIRED', attempts_remaining: remaining, last_failure: lastFailure };
  }

  /** Token-authorized: where the recipient stands. A session the vendor has finished is settled first. */
  async status(rawToken: string): Promise<IdentityVerificationStatusView> {
    const ctx = await this.esign.resolveSession(rawToken);
    const req = await this.requirement(ctx);
    if (req.method === null) return this.view(null, false, []);
    let rows = await this.attempts(ctx, req.method);
    const open = rows.find((r) => r.status === 'PENDING' && r.vendor_reference !== null);
    if (open !== undefined && !req.locked && this.port.isConfigured()) {
      await this.settle(open.id).catch((err: unknown) => this.logger.warn(`identity verification poll deferred — attempt ${open.id}: ${(err as Error).message}`));
      rows = await this.attempts(ctx, req.method);
      return this.view(req.method, (await this.requirement(ctx)).locked, rows);
    }
    return this.view(req.method, req.locked, rows);
  }

  /** Token-authorized: open (or resume) a vendor session for this recipient. */
  async start(rawToken: string, meta: { ip_address?: string; user_agent?: string } = {}): Promise<IdentityVerificationStartView> {
    const ctx = await this.esign.resolveSession(rawToken);
    const req = await this.requirement(ctx);
    if (req.method === null) return { ...this.view(null, false, []), verification_url: null };
    if (req.method === 'KBA') {
      // D-3/D-4: no KBA vendor is selected — the disabled adapter answers.
      if (this.kba?.isConfigured() !== true) throw new IdentityVerificationUnavailableError('kba_vendor_not_selected');
    }
    if (!this.port.isConfigured()) throw new IdentityVerificationUnavailableError('provider_not_configured');
    if (req.locked) throw new SignerIdentityVerificationLockedError(ctx.signer_id);

    let rows = await this.attempts(ctx, req.method);
    if (rows.some((r) => r.status === 'VERIFIED')) return { ...this.view(req.method, false, rows), verification_url: null };

    // Resume an open session rather than paying for a second one.
    const open = rows.find((r) => r.status === 'PENDING' && r.vendor_reference !== null);
    if (open !== undefined && open.vendor_reference !== null) {
      await this.settle(open.id);
      const after = await this.requirement(ctx);
      rows = await this.attempts(ctx, req.method);
      if (after.locked) throw new SignerIdentityVerificationLockedError(ctx.signer_id);
      const still = rows.find((r) => r.id === open.id);
      if (still?.status === 'PENDING') {
        const url = await this.port.resumeUrl(open.vendor_reference);
        return { ...this.view(req.method, false, rows), verification_url: url };
      }
      if (still?.status === 'VERIFIED') return { ...this.view(req.method, false, rows), verification_url: null };
    }

    // A new attempt, recorded under the envelope row lock before the vendor is called.
    const max = this.maxAttempts();
    const created = await this.prisma.$transaction(async (tx) => {
      await this.repo.lockSignableEnvelope(tx as unknown as LockingTx, ctx.tenant_id, ctx.envelope_id);
      const signer = await tx.signer.findFirstOrThrow({ where: { id: ctx.signer_id, tenant_id: ctx.tenant_id }, select: { identity_verification_locked_at: true } });
      if (signer.identity_verification_locked_at !== null) return { kind: 'locked' } as const;
      const existing = await tx.signRecipientIdentityVerification.findMany({ where: { tenant_id: ctx.tenant_id, signer_id: ctx.signer_id, method: req.method as string } });
      if (existing.some((r) => r.status === 'PENDING')) return { kind: 'busy' } as const;
      const started = existing.filter((r) => r.vendor_reference !== null).length;
      if (started >= max) {
        await this.lockIn(tx as unknown as LockingTx, ctx, 'attempts_exhausted', started);
        return { kind: 'exhausted' } as const;
      }
      const id = randomUUID();
      await tx.signRecipientIdentityVerification.create({
        data: { id, tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, signer_id: ctx.signer_id, session_id: ctx.session_id, method: req.method as string, provider: this.port.provider, status: 'PENDING' },
      });
      return { kind: 'created', id, attempt_number: started + 1 } as const;
    });
    if (created.kind === 'exhausted') {
      await this.tellSender(ctx, 'attempts_exhausted');
      throw new SignerIdentityVerificationLockedError(ctx.signer_id, 'attempts_exhausted');
    }
    if (created.kind === 'locked') throw new SignerIdentityVerificationLockedError(ctx.signer_id);
    if (created.kind === 'busy') {
      // Another start for this recipient is in flight; report where things stand.
      return { ...this.view(req.method, false, await this.attempts(ctx, req.method)), verification_url: null };
    }

    let session;
    try {
      session = await this.port.startSession({
        attempt_id: created.id,
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        signer_id: ctx.signer_id,
        return_url: identityVerificationReturnUrl(),
      });
    } catch (err) {
      // No vendor session exists: the attempt does not count and nothing is billed.
      await this.prisma.signRecipientIdentityVerification.updateMany({
        where: { id: created.id, status: 'PENDING', vendor_reference: null },
        data: { status: 'CANCELLED', completed_at: new Date(), failure_reason: 'vendor_unavailable' },
      });
      throw err instanceof IdentityVerificationUnavailableError ? err : new IdentityVerificationUnavailableError('provider_unreachable', true);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx as unknown as LockingTx, ctx.tenant_id, ctx.envelope_id);
      await tx.signRecipientIdentityVerification.update({ where: { id: created.id }, data: { vendor_reference: session.vendor_reference } });
      await this.repo.appendEvent(tx as unknown as LockingTx, {
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        signer_id: ctx.signer_id,
        event_type: IDENTITY_VERIFICATION_STARTED_EVENT,
        actor_type: 'SIGNER',
        actor_ref: ctx.signer_id,
        payload: { attempt_id: created.id, session_id: ctx.session_id, verification_method: req.method, provider: this.port.provider, vendor_reference: session.vendor_reference, attempt_number: created.attempt_number },
        ip_address: meta.ip_address,
        user_agent: meta.user_agent,
      });
    });
    // One metered unit per vendor session (idempotent on the attempt id). Never blocks the recipient.
    await this.usage
      ?.record({ tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, meter_key: SIGN_ID_VERIFICATION_ATTEMPT_METER, quantity: 1, idempotency_key: `sign-idv:${created.id}`, occurred_at: now })
      .catch((err: unknown) => this.logger.warn(`identity verification usage not recorded — attempt ${created.id}: ${(err as Error).message}`));

    const rowsAfter = await this.attempts(ctx, req.method);
    return { ...this.view(req.method, false, rowsAfter), verification_url: session.verification_url };
  }

  /** A verified vendor callback: settle the session it names (re-read from the vendor). */
  async handleWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSec: number): Promise<IdentityWebhookOutcome> {
    const evt = this.port.verifyWebhook(rawBody, signatureHeader, nowSec);
    if (evt.kind !== 'RESULT_AVAILABLE' || evt.vendor_reference === null) return 'IGNORED';
    const attempt = await this.prisma.signRecipientIdentityVerification.findFirst({
      where: { provider: this.port.provider, vendor_reference: evt.vendor_reference },
      select: { id: true },
    });
    if (attempt === null) return 'UNKNOWN_SESSION';
    return this.settle(attempt.id);
  }

  /**
   * Re-read one PENDING attempt's result from the vendor and record it once. Idempotent: a
   * settled attempt is left as it is. The vendor is called outside the transaction.
   */
  async settle(attempt_id: string): Promise<IdentityWebhookOutcome> {
    const attempt = await this.prisma.signRecipientIdentityVerification.findUnique({ where: { id: attempt_id } });
    if (attempt === null || attempt.vendor_reference === null) return 'UNKNOWN_SESSION';
    if (attempt.status !== 'PENDING') return 'ALREADY_SETTLED';
    const result = await this.port.retrieveResult(attempt.vendor_reference);
    if (result.outcome === 'PENDING') return 'PENDING';

    const ctx: SessionContext = { session_id: attempt.session_id, tenant_id: attempt.tenant_id, envelope_id: attempt.envelope_id, signer_id: attempt.signer_id };
    const max = this.maxAttempts();
    const now = new Date();
    const settled = await this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx as unknown as LockingTx, ctx.tenant_id, ctx.envelope_id);
      const fresh = await tx.signRecipientIdentityVerification.findUnique({ where: { id: attempt.id } });
      if (fresh === null || fresh.status !== 'PENDING') return null;
      const signer = await tx.signer.findFirstOrThrow({ where: { id: ctx.signer_id, tenant_id: ctx.tenant_id }, select: { name: true, identity_verification_locked_at: true } });
      const base = { attempt_id: attempt.id, verification_method: attempt.method, provider: attempt.provider, vendor_reference: attempt.vendor_reference };
      const event = (event_type: string, payload: Record<string, unknown>) =>
        this.repo.appendEvent(tx as unknown as LockingTx, { tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, signer_id: ctx.signer_id, event_type, actor_type: 'SERVICE', payload: { ...base, ...payload } });

      if (result.outcome === 'VERIFIED') {
        if (verifiedNameMatches(result.verified_name, signer.name)) {
          await tx.signRecipientIdentityVerification.update({
            where: { id: attempt.id },
            data: { status: 'VERIFIED', name_match: true, document_country: result.document_country, completed_at: now },
          });
          await event(IDENTITY_VERIFIED_EVENT, { name_match: true, document_country: result.document_country });
          return { notify: null, cancel: false } as const;
        }
        // Conservative policy: a document in another name fails, and the recipient is locked.
        await tx.signRecipientIdentityVerification.update({
          where: { id: attempt.id },
          data: { status: 'FAILED', name_match: false, document_country: result.document_country, failure_reason: 'name_mismatch', completed_at: now },
        });
        await event(IDENTITY_VERIFICATION_FAILED_EVENT, { reason: 'name_mismatch', name_match: false });
        if (signer.identity_verification_locked_at === null) await this.lockIn(tx as unknown as LockingTx, ctx, 'name_mismatch', null);
        return { notify: 'name_mismatch', cancel: false } as const;
      }

      const failed = result.outcome === 'FAILED';
      const reason = failed ? sanitizeFailure(result.failure_code) : null;
      await tx.signRecipientIdentityVerification.update({
        where: { id: attempt.id },
        data: { status: failed ? 'FAILED' : 'CANCELLED', failure_reason: reason, completed_at: now },
      });
      await event(failed ? IDENTITY_VERIFICATION_FAILED_EVENT : IDENTITY_VERIFICATION_CANCELLED_EVENT, failed ? { reason } : {});
      const started = await tx.signRecipientIdentityVerification.count({ where: { tenant_id: ctx.tenant_id, signer_id: ctx.signer_id, method: attempt.method, vendor_reference: { not: null } } });
      if (started >= max && signer.identity_verification_locked_at === null) {
        await this.lockIn(tx as unknown as LockingTx, ctx, 'attempts_exhausted', started);
        return { notify: 'attempts_exhausted', cancel: failed } as const;
      }
      return { notify: null, cancel: failed } as const;
    });
    if (settled === null) return 'ALREADY_SETTLED';
    // A failed session is closed at the vendor so it can never later turn into a pass.
    if (settled.cancel) {
      await this.port.cancelSession(attempt.vendor_reference).catch((err: unknown) => this.logger.warn(`vendor session not cancelled — attempt ${attempt.id}: ${(err as Error).message}`));
    }
    if (settled.notify !== null) await this.tellSender(ctx, settled.notify);
    return 'SETTLED';
  }

  // Locks the recipient out of verification for this envelope and revokes their live sessions.
  private async lockIn(tx: LockingTx, ctx: SessionContext, reason: 'attempts_exhausted' | 'name_mismatch', started: number | null): Promise<void> {
    const now = new Date();
    await tx.signer.update({ where: { id: ctx.signer_id }, data: { identity_verification_locked_at: now } });
    await tx.signingSession.updateMany({
      where: { tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, signer_id: ctx.signer_id, status: { in: [...LIVE_SESSION_STATUSES] } },
      data: { status: 'REVOKED', revoked_at: now },
    });
    await this.repo.appendEvent(tx, {
      tenant_id: ctx.tenant_id,
      envelope_id: ctx.envelope_id,
      signer_id: ctx.signer_id,
      event_type: IDENTITY_VERIFICATION_LOCKED_EVENT,
      actor_type: 'SERVICE',
      payload: { reason, ...(started !== null ? { attempts: started } : {}) },
    });
  }

  private async tellSender(ctx: SessionContext, reason: 'attempts_exhausted' | 'name_mismatch'): Promise<void> {
    await this.notifications?.identityVerificationFailed(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, reason).catch((err: unknown) => {
      this.logger.warn(`identity verification sender notice failed — envelope ${ctx.envelope_id}: ${(err as Error).message}`);
    });
  }

  /**
   * Sign purge (R-5): ask the vendor to delete the collected data of every session of an
   * envelope, and clear what Aramo kept beyond the outcome. Best-effort per session; a vendor
   * failure leaves redacted_at unset so a later run retries it.
   */
  async redactEnvelope(tenant_id: string, envelope_id: string, now: Date = new Date()): Promise<{ redacted: number; failed: number }> {
    const rows = await this.prisma.signRecipientIdentityVerification.findMany({ where: { tenant_id, envelope_id, redacted_at: null } });
    let redacted = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.vendor_reference !== null) {
        if (r.provider !== this.port.provider || !this.port.isConfigured()) {
          // The vendor that holds this session is not reachable now: retried by a later run.
          failed += 1;
          continue;
        }
        try {
          await this.port.redactSession(r.vendor_reference);
        } catch (err) {
          failed += 1;
          this.logger.warn(`vendor redaction failed — attempt ${r.id}: ${(err as Error).message}`);
          continue;
        }
      }
      await this.prisma.signRecipientIdentityVerification.update({ where: { id: r.id }, data: { document_country: null, failure_reason: null, redacted_at: now } });
      redacted += 1;
    }
    return { redacted, failed };
  }
}
