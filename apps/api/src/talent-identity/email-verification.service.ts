import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { ConsentService } from '@aramo/consent';
import {
  SOURCE_SYSTEM_ARAMO_ATS,
  maskIdentifierValue,
  normalizeEmailIdentifier,
  type CreateVerificationResponse,
  type ReferenceVerificationItem,
} from '@aramo/intelligence-contracts';
import { TalentRecordRepository } from '@aramo/talent-record';

import { type VerifiableEmailSlot } from './dto/email-verification.dto.js';
import { IntelligenceAccess, type IntelligenceStatus } from './intelligence-access.js';

// TR-3 B2 → ATI-SEP-1 T10 WP3b (Addendum A3 T10-3) — recruiter-initiated email
// verification, executed by Talent Intelligence as a 6-digit one-time code:
//
//   POST /v1/talent-records/:id/email-verifications { slot }
//     gates (in order): record in tenant → live → slot holds an address →
//     contacting/email consent (fails CLOSED) → TI enabled for the tenant →
//     TI POST /v1/verifications { source_reference: ARAMO_ATS/tenant/record,
//     identifier_type: EMAIL, value: <the STORED address> }.
//     TI mints the code and its delivery adapter mails it with the confirm link
//     (/email-verifications/confirm?verification_id=…); the talent enters the
//     code on the public confirm page (PublicVerificationController → TI confirm).
//   GET  /v1/talent-records/:id/email-verifications
//     per-slot status from TI GET …/verifications (VERIFIED / PENDING /
//     UNVERIFIED), matched to email1 / email2 by TI's masked form of the
//     normalized address (the value itself never crosses the TI wire back).
//
// The recipient is NEVER caller-chosen: the DTO names a STORED SLOT and the
// address is read off the record. The legacy link + token path (verification
// emails, token hashes, the trust ledger's VerificationRequest) is retired.

export type EmailSlotVerificationStatus = 'verified' | 'pending' | 'expired' | 'none';

export interface EmailSlotStatusView {
  slot: VerifiableEmailSlot;
  value_present: boolean;
  status: EmailSlotVerificationStatus;
  /** PENDING: the code's expiry; VERIFIED: when re-verification falls due. */
  expires_at: string | null;
}

export interface EmailVerificationStatusResponse {
  intelligence_status: IntelligenceStatus;
  items: EmailSlotStatusView[];
}

export interface RequestVerificationResult {
  verification_id: string;
  slot: VerifiableEmailSlot;
  status: 'PENDING';
  expires_at: string;
  /** QUEUED — the code is on its way; NOT_AVAILABLE — TI cannot deliver on this channel. */
  delivery: CreateVerificationResponse['delivery'];
}

const STATUS_OF: Record<ReferenceVerificationItem['status'], EmailSlotVerificationStatus> = {
  VERIFIED: 'verified',
  PENDING: 'pending',
  UNVERIFIED: 'none',
};

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly consent: ConsentService,
    private readonly ti: IntelligenceAccess,
  ) {}

  async requestVerification(input: {
    recordId: string;
    slot: VerifiableEmailSlot;
    authContext: AuthContextType;
    requestId: string;
  }): Promise<RequestVerificationResult> {
    const { recordId, slot, authContext, requestId } = input;
    const tenantId = authContext.tenant_id;

    // Gate 1 — the record exists in THIS tenant.
    const record = await this.talentRecords.findById({ tenant_id: tenantId, id: recordId });
    if (record === null) {
      throw new AramoError('NOT_FOUND', 'talent record not found', 404, { requestId, details: { talent_record_id: recordId } });
    }
    // Gate 2 — the record is live.
    if (record.record_status !== 'live') {
      throw new AramoError('TALENT_RECORD_SUPERSEDED', 'talent record is superseded', 422, {
        requestId,
        details: { talent_record_id: recordId },
      });
    }
    // Gate 3 — the named slot holds an address.
    const rawAddress = slot === 'email1' ? record.email1 : record.email2;
    if (rawAddress === null || normalizeEmailIdentifier(rawAddress).length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'the named email slot holds no address', 400, {
        requestId,
        details: { slot, reason: 'email_slot_empty' },
      });
    }
    // Gate 4 — consent (contacting/email), fail CLOSED (the ruled TR-3 divergence).
    const decision = await this.consent.check(
      { talent_record_id: recordId, operation: 'selection', channel: 'email' },
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
      throw new AramoError('VERIFICATION_CONSENT_REQUIRED', 'consent required to send a verification email', 403, {
        requestId,
        details: { consent_decision: decision, reason: decision.result },
      });
    }
    // Gate 5 — TI executes the verification (enabled for this tenant).
    const r = await this.ti.act(tenantId, requestId, (c) =>
      c.requestVerification({
        source_reference: { source_system_id: SOURCE_SYSTEM_ARAMO_ATS, source_tenant_id: tenantId, external_talent_id: recordId },
        identifier_type: 'EMAIL',
        value: rawAddress.trim(),
      }),
    );
    return { verification_id: r.verification_id, slot, status: 'PENDING', expires_at: r.expires_at, delivery: r.delivery };
  }

  async getStatus(input: { recordId: string; authContext: AuthContextType; requestId: string }): Promise<EmailVerificationStatusResponse> {
    const { recordId, authContext, requestId } = input;
    const tenantId = authContext.tenant_id;
    const record = await this.talentRecords.findById({ tenant_id: tenantId, id: recordId });
    if (record === null) {
      throw new AramoError('NOT_FOUND', 'talent record not found', 404, { requestId, details: { talent_record_id: recordId } });
    }
    const slots: Array<{ slot: VerifiableEmailSlot; normalized: string }> = (['email1', 'email2'] as const).map((slot) => {
      const raw = slot === 'email1' ? record.email1 : record.email2;
      return { slot, normalized: raw === null ? '' : normalizeEmailIdentifier(raw) };
    });

    const read = await this.ti.read(tenantId, (c) => c.listReferenceVerifications({ tenant_id: tenantId, talent_id: recordId }));
    const tiItems = (read.value?.items ?? []).filter((i) => i.identifier_type === 'EMAIL');

    const items = slots.map(({ slot, normalized }): EmailSlotStatusView => {
      if (normalized.length === 0) return { slot, value_present: false, status: 'none', expires_at: null };
      const mask = maskIdentifierValue(normalized);
      // Two DIFFERENT addresses sharing one masked form cannot be told apart:
      // report the honest "none" rather than guess.
      const ambiguous = slots.some((o) => o.slot !== slot && o.normalized !== normalized && o.normalized !== '' && maskIdentifierValue(o.normalized) === mask);
      const match = ambiguous ? undefined : tiItems.find((i) => i.value_masked === mask);
      if (match === undefined) return { slot, value_present: true, status: 'none', expires_at: null };
      return { slot, value_present: true, status: STATUS_OF[match.status], expires_at: match.expires_at };
    });
    return { intelligence_status: read.status, items };
  }
}

