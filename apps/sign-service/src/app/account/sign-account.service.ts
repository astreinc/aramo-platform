import { Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { IdentityRepository, IdentityService, PersonalRiskService, TenantRepository, TENANT_OWNER_ROLE_KEY } from '@aramo/identity';

import { ConvenienceDataPurgeService } from '../push/convenience-data-purge.service.js';
import { SavedDataPurgeService } from '../me/signature/saved-data-purge.service.js';
import { SignPurgeService } from '../retention/sign-purge.service.js';

// Aramo Sign Personal (Free) — "Close account" in Sign settings (PO decision
// 2026-10-22; Personal Terms: "You may close your account at any time from your
// account settings"). The signed-in OWNER of a PERSONAL tenant closes it here.
//
// It performs exactly the operator's close (PersonalRiskService.close — the one
// close path in identity): the tenant's risk state becomes `closed`, audited in the
// same transaction with the owner as the actor. What `closed` does today:
//   - sending stops for good (the Personal send gate refuses: personal_restricted);
//   - envelopes already sent are left as they are (signers can still complete);
//   - sign-web signs the owner out of THIS session right after the close; other
//     sessions are not ended and only see the closed notice (the workspace is
//     replaced by it, so documents can no longer be opened or downloaded);
//   - the tenant lifecycle status is unchanged (sign-in still works and the
//     workspace shows the account as closed).
// Retention and Purge directive (ebd41d99) R-11: when purge is enabled (SIGN_PURGE_ENABLED=1)
// the close also queues every completed, declined or voided envelope of the account for the
// full purge (documents, metadata and personal data) after the 14-day queue; Aramo legal hold
// blocks it. With purge disabled nothing is deleted here (a deletion request goes to privacy@aramo.ai).
//
// Refusals (stable details.reason):
//   account_close_confirmation_required  400  body.confirm is not exactly 'CLOSE'
//   business_account_close_via_organization  403  a BUSINESS tenant (closed by its organization / the operator)
//   not_account_owner                    403  the caller does not hold tenant_owner in this tenant
//   personal_account_not_closable        404  a PERSONAL tenant with no Personal risk state
// Closing an already closed account answers 200 with the closed state (idempotent).

export const CLOSE_CONFIRMATION = 'CLOSE';
export const OWNER_CLOSE_REASON = 'owner_closed';
const MAX_NOTE = 500;

export interface SignAccountStatus {
  // True only for the owner of an open PERSONAL account with a Personal risk state.
  closable: boolean;
  closed: boolean;
  closed_at: string | null;
}

export interface SignAccountClosed {
  state: 'closed';
  closed_at: string;
}

@Injectable()
export class SignAccountService {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly repo: IdentityRepository,
    private readonly identity: IdentityService,
    private readonly risk: PersonalRiskService,
    // Sign Mobile M-A3 §9 — the close revokes push devices and deletes notification convenience data.
    @Optional() private readonly purge?: ConvenienceDataPurgeService,
    // Sign Mobile M-A3 §9 — and deletes saved signatures and contacts.
    @Optional() private readonly savedData?: SavedDataPurgeService,
    // Retention and Purge directive (ebd41d99) R-11 — closure queues the account's envelopes
    // for the DocuSign-style purge (only when SIGN_PURGE_ENABLED=1; a no-op otherwise).
    @Optional() private readonly envelopePurge?: SignPurgeService,
  ) {}

  /** The account's close state for the workspace (never throws for a valid session). */
  async status(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>): Promise<SignAccountStatus> {
    const tenant = await this.tenants.findById(auth.tenant_id);
    if (tenant === null || tenant.kind !== 'PERSONAL') return { closable: false, closed: false, closed_at: null };
    const state = await this.risk.riskStateOf(auth.tenant_id);
    if (state === null) return { closable: false, closed: false, closed_at: null };
    if (state.state === 'closed') return { closable: false, closed: true, closed_at: state.updated_at.toISOString() };
    return { closable: await this.isOwner(auth.tenant_id, auth.sub), closed: false, closed_at: null };
  }

  async close(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>, body: { confirm?: unknown; reason?: unknown } | undefined, requestId: string): Promise<SignAccountClosed> {
    if (body?.confirm !== CLOSE_CONFIRMATION) {
      throw new AramoError('VALIDATION_ERROR', 'Type CLOSE to confirm closing your account', 400, {
        requestId,
        details: { reason: 'account_close_confirmation_required' },
      });
    }
    if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== 'string' || body.reason.length > MAX_NOTE)) {
      throw new AramoError('VALIDATION_ERROR', `The reason must be text of at most ${MAX_NOTE} characters`, 400, {
        requestId,
        details: { reason: 'invalid_close_reason' },
      });
    }
    const tenant = await this.tenants.findById(auth.tenant_id);
    if (tenant === null) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Tenant not found for this session', 403, { requestId, details: { reason: 'tenant_unknown' } });
    }
    if (tenant.kind !== 'PERSONAL') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'An organization account is closed by its organization administrator', 403, {
        requestId,
        details: { reason: 'business_account_close_via_organization' },
      });
    }
    if (!(await this.isOwner(auth.tenant_id, auth.sub))) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Only the account owner can close this account', 403, {
        requestId,
        details: { reason: 'not_account_owner' },
      });
    }
    const current = await this.risk.riskStateOf(auth.tenant_id);
    if (current === null) {
      throw new AramoError('NOT_FOUND', 'This account cannot be closed here', 404, {
        requestId,
        details: { reason: 'personal_account_not_closable' },
      });
    }
    if (current.state === 'closed') {
      await this.purge?.purgeForAccountClose({ tenant_id: auth.tenant_id, user_id: auth.sub });
      await this.savedData?.purgeForAccountClose({ tenant_id: auth.tenant_id, user_id: auth.sub });
      return { state: 'closed', closed_at: current.updated_at.toISOString() };
    }
    const note = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : null;
    try {
      // Sessions are not revoked (Lead: "where applicable"): revocation is user-wide across tenants, so it is not applied here.
      const closed = await this.risk.close(auth.tenant_id, auth.sub, OWNER_CLOSE_REASON, new Date(), { closed_by: 'owner', note });
      await this.purge?.purgeForAccountClose({ tenant_id: auth.tenant_id, user_id: auth.sub });
      await this.savedData?.purgeForAccountClose({ tenant_id: auth.tenant_id, user_id: auth.sub });
      await this.envelopePurge?.queueForAccountClosure(auth.tenant_id, auth.sub);
      return { state: 'closed', closed_at: closed.updated_at.toISOString() };
    } catch (err) {
      // A concurrent close (operator or a second tab) won the race: answer the closed state.
      const after = await this.risk.riskStateOf(auth.tenant_id);
      if (after?.state === 'closed') return { state: 'closed', closed_at: after.updated_at.toISOString() };
      throw err;
    }
  }

  private async isOwner(tenant_id: string, user_id: string): Promise<boolean> {
    const membership = await this.repo.findMembership({ user_id, tenant_id });
    if (membership === null || membership.is_active === false) return false;
    const keys = await this.identity.findRoleKeysForMembership(membership.id);
    return keys.includes(TENANT_OWNER_ROLE_KEY);
  }
}
