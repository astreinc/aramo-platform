import { Injectable } from '@nestjs/common';
import { IdentityLinkService, IdentityService, normalizeIdp, type FederatedIdp } from '@aramo/identity';
import type {
  AccountLinkAttachResult,
  AccountLinkDirectory,
  AccountLinkIdentity,
  AccountLinkMethod,
  AccountLinkProof,
  AccountLinkRemoveResult,
  AccountLinkVerifyResult,
} from '@aramo/auth-core';

// Apple Go-Live Amendment A1 (LOCKED) — the Aramo-side adapter implementing auth's
// AccountLinkDirectory over @aramo/identity's IdentityLinkService (ADR-0021 §2:
// auth owns the port, this adapter is the only code that knows users, tenants
// and the attach policy). A pass-through apart from two identity facts:
//   - the conflict case records the user whose email matched (matched_user_id),
//     looked up by the same normalized verified email the reconcile used;
//   - only a single resolved provider (google | microsoft | apple) can link.

function resolvedIdp(raw: string | null): FederatedIdp | null {
  const idp = normalizeIdp(raw);
  return idp === null || idp === 'ambiguous' ? null : idp;
}

@Injectable()
export class IdentityAccountLinkAdapter implements AccountLinkDirectory {
  constructor(
    private readonly links: IdentityLinkService,
    private readonly identity: IdentityService,
  ) {}

  async createPendingLink(input: AccountLinkIdentity & { reason: string }): Promise<{ handle: string; idp: string } | null> {
    const idp = resolvedIdp(input.idp);
    if (idp === null) return null;
    if (input.reason !== 'user_not_provisioned' && input.reason !== 'idp_identity_conflict') return null;
    let matched_user_id: string | null = null;
    if (input.reason === 'idp_identity_conflict') {
      const matched = await this.identity.findUserByEmail(input.verified_email.trim().toLowerCase());
      if (matched === null) return null;
      matched_user_id = matched.id;
    }
    const { handle } = await this.links.createPendingLink({
      provider: input.provider,
      provider_subject: input.provider_subject,
      idp,
      email_snapshot: input.verified_email,
      reason: input.reason,
      matched_user_id,
    });
    return { handle, idp };
  }

  attachPendingLink(input: { handle: string; principal_id: string }): Promise<AccountLinkAttachResult> {
    return this.links.attachPendingLink({ handle: input.handle, user_id: input.principal_id, proof: 'existing_provider' });
  }

  async attachIdentity(input: AccountLinkIdentity & { principal_id: string; proof: AccountLinkProof }): Promise<AccountLinkAttachResult> {
    const idp = resolvedIdp(input.idp);
    if (idp === null) return { ok: false, reason: 'idp_not_permitted_for_tenant' };
    return this.links.attachIdentity({
      provider: input.provider,
      provider_subject: input.provider_subject,
      idp,
      email_snapshot: input.verified_email,
      user_id: input.principal_id,
      proof: input.proof,
    });
  }

  startEmailProof(input: { handle: string; email: string | null }): Promise<{ to: string; code: string; idp: string } | null> {
    return this.links.startEmailProof({ handle: input.handle, email: input.email });
  }

  verifyEmailProof(input: { handle: string; code: unknown }): Promise<AccountLinkVerifyResult> {
    return this.links.verifyEmailProof({ handle: input.handle, code: input.code });
  }

  async listSignInMethods(principal_id: string): Promise<AccountLinkMethod[]> {
    const rows = await this.links.listSignInMethods(principal_id);
    return rows.map((r) => ({ idp: r.idp, email_snapshot: r.email_snapshot, linked_at: r.linked_at.toISOString() }));
  }

  async removeSignInMethod(input: { principal_id: string; idp: string }): Promise<AccountLinkRemoveResult> {
    const r = await this.links.removeSignInMethod({ user_id: input.principal_id, idp: input.idp });
    return r.ok ? { ok: true, idp: r.idp, account_email: r.account_email } : r;
  }
}
