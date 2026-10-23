import { Inject, Injectable } from '@nestjs/common';
import { EntitlementRepository } from '@aramo/entitlement';
import {
  SOURCE_SYSTEM_ARAMO_ATS,
  type ConfirmVerificationResponse,
  type CreateVerificationResponse,
} from '@aramo/intelligence-contracts';
import { TalentIntelligenceRepository } from '@aramo/talent-record';

import { INTELLIGENCE_INTEGRATION_CONFIG, type IntelligenceIntegrationConfig } from './intelligence-config.js';
import { IntelligenceClient } from './intelligence-client.js';

// ATI-SEP-1 T8 (ADR-0036 §5 "Verification v1") — the portal identifier
// verification, routed to Talent Intelligence: the portal talent asks to verify
// one of the stored emails of their ATS record → the ATS calls TI
// POST /v1/verifications with the talent's ATS source reference → TI mints the
// one-time code and emits identifier_verification.requested (TI-internal; its
// delivery adapter mails the code). The talent then confirms the code through
// the ATS, which relays it to TI POST /v1/verifications/:id/confirm.
//
// GATED: INTELLIGENCE_VERIFICATION_ENABLED=true AND the TI client configured AND
// the record's tenant holds `intelligence`. Otherwise the route reports the
// feature as not available. The LEGACY trust email verification
// (EmailVerificationService / PublicVerificationController, link + token) is
// untouched and stays the live path until T10 retires it.
//
// The address is NEVER caller-chosen: the caller names a stored slot
// (email1 | email2) and the address is read off the record.

export type VerifiableIdentifierSlot = 'email1' | 'email2';

export class IntelligenceVerificationDisabledError extends Error {
  constructor(readonly reason: 'DISABLED' | 'NOT_CONFIGURED' | 'NOT_ENTITLED') {
    super(`Talent Intelligence verification is not available (${reason})`);
    this.name = 'IntelligenceVerificationDisabledError';
  }
}

export class IdentifierSlotEmptyError extends Error {
  constructor(readonly slot: VerifiableIdentifierSlot) {
    super(`the ${slot} slot holds no address`);
    this.name = 'IdentifierSlotEmptyError';
  }
}

@Injectable()
export class IntelligenceVerificationService {
  constructor(
    @Inject(INTELLIGENCE_INTEGRATION_CONFIG) private readonly config: IntelligenceIntegrationConfig,
    private readonly client: IntelligenceClient,
    private readonly entitlements: EntitlementRepository,
    private readonly records: TalentIntelligenceRepository,
  ) {}

  /** Throws IntelligenceVerificationDisabledError when the TI path is off for this tenant. */
  async assertAvailable(tenantId: string): Promise<void> {
    if (!this.config.verificationEnabled) throw new IntelligenceVerificationDisabledError('DISABLED');
    if (!this.client.configured) throw new IntelligenceVerificationDisabledError('NOT_CONFIGURED');
    const capabilities = await this.entitlements.getCapabilities(tenantId);
    if (!capabilities.has('intelligence')) throw new IntelligenceVerificationDisabledError('NOT_ENTITLED');
  }

  async request(args: { tenant_id: string; talent_record_id: string; slot: VerifiableIdentifierSlot }): Promise<CreateVerificationResponse | null> {
    await this.assertAvailable(args.tenant_id);
    const record = await this.records.readAdmissibleRecord({ tenant_id: args.tenant_id, id: args.talent_record_id });
    if (record === null) return null;
    const address = (args.slot === 'email1' ? record.email1 : record.email2)?.trim() ?? '';
    if (address.length === 0) throw new IdentifierSlotEmptyError(args.slot);
    return this.client.requestVerification({
      source_reference: {
        source_system_id: SOURCE_SYSTEM_ARAMO_ATS,
        source_tenant_id: args.tenant_id,
        external_talent_id: args.talent_record_id,
      },
      identifier_type: 'EMAIL',
      value: address,
    });
  }

  async confirm(args: { tenant_id: string; verification_id: string; code: string }): Promise<ConfirmVerificationResponse> {
    await this.assertAvailable(args.tenant_id);
    return this.client.confirmVerification(args.verification_id, args.code);
  }
}
