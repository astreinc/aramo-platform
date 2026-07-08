import { Inject, Injectable, Logger } from '@nestjs/common';
import { AramoError, normalizeEmail } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { ConsentService } from '@aramo/consent';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import { TalentRecordRepository } from '@aramo/talent-record';
import { TalentTrustRepository, TalentTrustService } from '@aramo/talent-trust';

import { type VerifiableEmailSlot } from './dto/email-verification.dto.js';
import {
  buildConfirmUrl,
  loadVerificationLinkConfig,
  renderVerificationEmail,
} from './verification-emails.js';
import {
  generateVerificationToken,
  verificationExpiresAt,
} from './verification-token.js';

// TR-3 B2 (§3.1) — the email-verification REQUEST orchestrator. Lives in
// apps/api (the promotion/reconcile boundary precedent, ABOVE the I15 wall):
// it composes talent-record (the stored slots), consent (the send gate), the
// cip trust ledger (the request row + subject), and the mailer — none of which
// import one another. talent_trust imports NO ats; this is the only place the
// four meet.
//
// The recipient is NEVER caller-chosen: the DTO carries a STORED SLOT
// (email1/email2), and this service reads the address off the record. A
// caller-supplied address is structurally impossible (acceptance (c)).

// The status of one stored email slot, for the record-detail surface (§3.3).
//   verified — a PLATFORM_VERIFIED EMAIL anchor exists for the value.
//   pending  — an open, non-expired request is outstanding.
//   expired  — the latest request lapsed (or was consumed without a live anchor).
//   none     — the slot holds no address, or nothing has been requested.
export type EmailSlotVerificationStatus =
  | 'verified'
  | 'pending'
  | 'expired'
  | 'none';

export interface EmailSlotStatusView {
  slot: VerifiableEmailSlot;
  value_present: boolean;
  status: EmailSlotVerificationStatus;
}

export interface RequestVerificationResult {
  verification_id: string;
  slot: VerifiableEmailSlot;
  status: 'PENDING';
  expires_at: string;
  // True when an open request already existed and was resent (token rotated in
  // place, same request identity) rather than freshly minted (acceptance (d)).
  resent: boolean;
}

// No tenant display-name source is threaded through the JWT (AuthContext carries
// no tenant_name); a later slice can pass the tenant label. The renderer reads
// fine with the product name as the label.
const DEFAULT_TENANT_LABEL = 'Aramo';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly trustRepo: TalentTrustRepository,
    private readonly trust: TalentTrustService,
    private readonly consent: ConsentService,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
  ) {}

  // §3.1 — the request path. Gates run IN ORDER; the first failure throws.
  async requestVerification(input: {
    recordId: string;
    slot: VerifiableEmailSlot;
    authContext: AuthContextType;
    requestId: string;
  }): Promise<RequestVerificationResult> {
    const { recordId, slot, authContext, requestId } = input;
    const tenantId = authContext.tenant_id;

    // Gate 1 — the record exists in THIS tenant (findById is tenant-scoped).
    const record = await this.talentRecords.findById({
      tenant_id: tenantId,
      id: recordId,
    });
    if (record === null) {
      throw new AramoError('NOT_FOUND', 'talent record not found', 404, {
        requestId,
        details: { talent_record_id: recordId },
      });
    }

    // Gate 2 — the record is live (a superseded record is refused; the same
    // operational-refusal code the B3a send-gate uses).
    if (record.record_status !== 'live') {
      throw new AramoError(
        'TALENT_RECORD_SUPERSEDED',
        'talent record is superseded',
        422,
        { requestId, details: { talent_record_id: recordId } },
      );
    }

    // Gate 3 — the named slot actually holds an address. The slot itself is
    // DTO-validated (email1|email2); an empty slot is a 400 (nothing to verify).
    const rawAddress = slot === 'email1' ? record.email1 : record.email2;
    const normalized =
      rawAddress === null ? '' : normalizeEmail(rawAddress);
    if (rawAddress === null || normalized.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'the named email slot holds no address',
        400,
        { requestId, details: { slot, reason: 'email_slot_empty' } },
      );
    }

    // Gate 4 — consent (contacting/email). THE RULED DIVERGENCE (DDR §2.1): a
    // verification email is a voluntary enhancement, so it fails CLOSED on an
    // unknown consent state — BOTH `denied` AND `error`/empty-ledger map to 403
    // VERIFICATION_CONSENT_REQUIRED (the engagement send-gate, by contrast, maps
    // empty-ledger to 500). `engagement` is the existing operation that derives
    // the `contacting` scope; TR-3 adds NO consent-vocabulary value (§1).
    const decision = await this.consent.check(
      { talent_record_id: recordId, operation: 'engagement', channel: 'email' },
      undefined,
      authContext,
      requestId,
    );
    if (decision.result !== 'allowed') {
      this.logger.log({
        event: 'email_verification.request_refused',
        error_code: 'VERIFICATION_CONSENT_REQUIRED',
        tenant_id: tenantId,
        talent_record_id: recordId,
        consent_result: decision.result,
        reason_code: decision.reason_code,
      });
      throw new AramoError(
        'VERIFICATION_CONSENT_REQUIRED',
        'consent required to send a verification email',
        403,
        {
          requestId,
          details: { consent_decision: decision, reason: decision.result },
        },
      );
    }

    // Resolve (or materialize) the record's trust subject — the same subject the
    // ATS anchor producer keys the unverified SELF email anchor to, so the
    // PLATFORM_VERIFIED row confirm mints will sit beside it.
    const subjectId = await this.trustRepo.resolveOrCreateSubject(
      tenantId,
      'ATS_TALENT_RECORD',
      recordId,
      'verification',
    );

    const now = new Date();
    const token = generateVerificationToken();
    const expiresAt = verificationExpiresAt(now);

    // Idempotent open-request (§3.1, acceptance (d)): one live request per
    // (subject, kind, value). A repeat while one is open is a RESEND — rotate the
    // token in place (old link dies), re-stamp the TTL, keep the same identity.
    const open = await this.trustRepo.findOpenVerificationRequest(
      tenantId,
      subjectId,
      'EMAIL',
      normalized,
      now,
    );
    const requestRow =
      open === null
        ? await this.trustRepo.createVerificationRequest({
            tenant_id: tenantId,
            talent_record_id: recordId,
            subject_id: subjectId,
            anchor_kind: 'EMAIL',
            normalized_value: normalized,
            token_hash: token.hash,
            created_by: authContext.sub,
            expires_at: expiresAt,
          })
        : await this.trustRepo.rotateVerificationToken(
            open.id,
            token.hash,
            expiresAt,
          );

    // Send via the mailer port — to the STORED address (never a caller value).
    const { confirmBaseUrl } = loadVerificationLinkConfig();
    const rendered = renderVerificationEmail({
      tenantLabel: DEFAULT_TENANT_LABEL,
      confirmUrl: buildConfirmUrl(confirmBaseUrl, token.raw),
    });
    await this.mailer.send({
      to: rawAddress,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    return {
      verification_id: requestRow.id,
      slot,
      status: 'PENDING',
      expires_at: requestRow.expires_at.toISOString(),
      resent: open !== null,
    };
  }

  // §3.3 — per-slot verification status for the record-detail surface. Verified
  // is read off the PLATFORM_VERIFIED anchor (bands, never a number); pending /
  // expired off the request rows. Read-only; no subject is created here.
  async getStatus(input: {
    recordId: string;
    authContext: AuthContextType;
    requestId: string;
  }): Promise<{ items: EmailSlotStatusView[] }> {
    const { recordId, authContext, requestId } = input;
    const tenantId = authContext.tenant_id;

    const record = await this.talentRecords.findById({
      tenant_id: tenantId,
      id: recordId,
    });
    if (record === null) {
      throw new AramoError('NOT_FOUND', 'talent record not found', 404, {
        requestId,
        details: { talent_record_id: recordId },
      });
    }

    const subject = await this.trust.resolveSubjectRef({
      tenant_id: tenantId,
      ref_type: 'ATS_TALENT_RECORD',
      ref_id: recordId,
    });
    const now = new Date();

    const slots: VerifiableEmailSlot[] = ['email1', 'email2'];
    const items: EmailSlotStatusView[] = [];
    for (const slot of slots) {
      const rawAddress = slot === 'email1' ? record.email1 : record.email2;
      const normalized =
        rawAddress === null ? '' : normalizeEmail(rawAddress);
      if (normalized.length === 0) {
        items.push({ slot, value_present: false, status: 'none' });
        continue;
      }
      if (subject === null) {
        items.push({ slot, value_present: true, status: 'none' });
        continue;
      }
      const verified = await this.trustRepo.findSubjectAnchor(
        tenantId,
        subject.id,
        'EMAIL',
        normalized,
        'PLATFORM_VERIFIED',
      );
      if (verified !== null) {
        items.push({ slot, value_present: true, status: 'verified' });
        continue;
      }
      const open = await this.trustRepo.findOpenVerificationRequest(
        tenantId,
        subject.id,
        'EMAIL',
        normalized,
        now,
      );
      if (open !== null) {
        items.push({ slot, value_present: true, status: 'pending' });
        continue;
      }
      const latest = await this.trustRepo.findLatestVerificationRequest(
        tenantId,
        subject.id,
        'EMAIL',
        normalized,
      );
      items.push({
        slot,
        value_present: true,
        status: latest === null ? 'none' : 'expired',
      });
    }
    return { items };
  }
}
