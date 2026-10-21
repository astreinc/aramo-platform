import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  ESIGN_ROLE_DISPLAY,
  ESIGN_ROLE_KEYS,
  type EsignRoleKey,
  IdentityRepository,
  IdentityService,
  isEsignRoleKey,
  SIGN_ORGANIZATION_ROLE_DISPLAY,
  SIGN_ORGANIZATION_ROLE_KEYS,
  type SignOrganizationRoleKey,
} from '@aramo/identity';

import { SenderContextService } from './sender-context.service.js';

// Sign Unified Product S-1 — Sign member administration (directive §4.3.3/§4.3.4).
// A holder of sign:member:manage assigns or removes the ONE Sign role of an
// organization member. Only the Sign role changes: every other role the member
// holds (organization, ATS) is carried over untouched. The tenant, the acting
// user and the target membership come only from the verified auth context and
// the server-side membership lookup.
//
// ROLES-1 PR-3 (Directive v1.0 LOCKED §1, §3.5, §4.3, §8; Conforming Amendments 4 and
// 6) — the Sign Owner role is retired. The Sign roles are sign_admin / sign_sender /
// sign_viewer; Sign ownership and billing belong to the ORGANIZATION owner
// (tenant_owner), and the organization administrator (tenant_admin) holds every Sign
// permission except billing. The precedence and the owner logic move to tenant_owner:
//   - the list shows each member's organization role (tenant_owner over tenant_admin)
//     next to their Sign role, so an organization-role holder reads as the Sign
//     Owner / Admin equivalent they are;
//   - organization roles are NEVER granted or removed here (they are not Sign roles):
//     the change carries them over, so an owner cannot be demoted through Sign member
//     administration. The change still runs under the caller's owner authority, so the
//     identity owner-only and organization-admin rules (ROLES-1 PR-1 / PR-3) and the DB
//     last-owner trigger (§4.1) stay the backstop; a last-owner refusal from that
//     backstop is answered with this API's documented 409 ESIGN_LAST_OWNER.
//
// Rules (fail closed):
//   - BUSINESS tenants only (a PERSONAL account has no members to administer).
//   - the target must be a member of the caller's own tenant (else 404).
//   - sign_role is a Sign role or null; the retired sign_owner key is refused (400).
//   - assignability (the tenant holds `sign`), the role-union check and the
//     authz_version bump are IdentityService.replaceMembershipRoles' (one home).

const PRECEDENCE: Record<EsignRoleKey, number> = { sign_admin: 3, sign_sender: 2, sign_viewer: 1 };

export interface SignMemberView {
  user_id: string;
  email: string;
  display_name: string | null;
  active: boolean;
  sign_role: EsignRoleKey | null;
  sign_role_display: string | null;
  // ROLES-1 PR-3 — the member's organization role (tenant_owner over tenant_admin), or
  // null. Read-only here; it carries the Sign authority of the organization role.
  organization_role: SignOrganizationRoleKey | null;
  organization_role_display: string | null;
}

function signRoleOf(keys: readonly string[]): EsignRoleKey | null {
  let best: EsignRoleKey | null = null;
  for (const k of keys) {
    if (isEsignRoleKey(k) && (best === null || PRECEDENCE[k] > PRECEDENCE[best])) best = k;
  }
  return best;
}

// SIGN_ORGANIZATION_ROLE_KEYS is in precedence order (owner first).
function organizationRoleOf(keys: readonly string[]): SignOrganizationRoleKey | null {
  return SIGN_ORGANIZATION_ROLE_KEYS.find((k) => keys.includes(k)) ?? null;
}

function memberView(u: { user_id: string; email: string; display_name: string | null; is_active: boolean; role_keys: readonly string[] }): SignMemberView {
  const role = signRoleOf(u.role_keys);
  const org = organizationRoleOf(u.role_keys);
  return {
    user_id: u.user_id,
    email: u.email,
    display_name: u.display_name,
    active: u.is_active,
    sign_role: role,
    sign_role_display: role === null ? null : ESIGN_ROLE_DISPLAY[role],
    organization_role: org,
    organization_role_display: org === null ? null : SIGN_ORGANIZATION_ROLE_DISPLAY[org],
  };
}

@Injectable()
export class SenderMembersService {
  private readonly log = new Logger(SenderMembersService.name);

  constructor(
    private readonly ctx: SenderContextService,
    private readonly repo: IdentityRepository,
    private readonly identity: IdentityService,
  ) {}

  private async assertBusiness(auth: AuthContextType, requestId: string): Promise<void> {
    const kind = await this.ctx.tenantKind(auth.tenant_id, requestId);
    if (kind !== 'BUSINESS') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Member administration is available to organization accounts only', 403, {
        requestId,
        details: { reason: 'personal_account' },
      });
    }
  }

  async list(auth: AuthContextType, requestId: string): Promise<{ items: SignMemberView[]; roles: { key: EsignRoleKey; display: string }[] }> {
    await this.assertBusiness(auth, requestId);
    const users = await this.repo.listTenantUsers(auth.tenant_id);
    return {
      items: users.map(memberView),
      roles: ESIGN_ROLE_KEYS.map((key) => ({ key, display: ESIGN_ROLE_DISPLAY[key] })),
    };
  }

  async setRole(auth: AuthContextType, user_id: string, body: { sign_role?: unknown }, requestId: string): Promise<SignMemberView> {
    await this.assertBusiness(auth, requestId);
    const requested = body?.sign_role;
    if (requested !== null && (typeof requested !== 'string' || !isEsignRoleKey(requested))) {
      throw new AramoError('VALIDATION_ERROR', 'sign_role must be one of the Sign roles, or null to remove access', 400, {
        requestId,
        details: { allowed: [...ESIGN_ROLE_KEYS, null] },
      });
    }
    const target = await this.repo.findMembership({ user_id, tenant_id: auth.tenant_id });
    if (target === null) {
      throw new AramoError('NOT_FOUND', 'No member with that id in this organization', 404, { requestId });
    }
    const before = await this.identity.findRoleKeysForMembership(target.id);
    const current = signRoleOf(before);
    const next = requested as EsignRoleKey | null;
    if (current === next) return this.view(user_id, auth.tenant_id, requestId);

    const role_keys = [...before.filter((k) => !isEsignRoleKey(k)), ...(next === null ? [] : [next])];
    const role_ids = await this.identity.resolveRoleIdsByKeys(role_keys);
    try {
      await this.identity.replaceMembershipRoles({
        membership_id: target.id,
        tenant_id: auth.tenant_id,
        role_keys,
        role_ids,
        request_id: requestId,
        // Organization roles are carried over (no owner / org-admin delta); the authority
        // is passed so the identity rules decide if that ever changed.
        owner_role_authority: { actor_user_id: auth.sub },
      });
    } catch (err) {
      // ROLES-1 PR-3 (§4.3) — the DB last-owner backstop keeps its documented Sign answer.
      if (err instanceof AramoError && err.code === 'TENANT_LAST_OWNER') {
        throw new AramoError('ESIGN_LAST_OWNER', 'The organization must keep at least one owner', 409, {
          requestId,
          details: { reason: 'last_owner' },
        });
      }
      throw err;
    }
    this.log.log(
      `sign role change tenant=${auth.tenant_id} actor=${auth.sub} target=${user_id} from=${current ?? 'none'} to=${next ?? 'none'} request=${requestId}`,
    );
    return this.view(user_id, auth.tenant_id, requestId);
  }

  private async view(user_id: string, tenant_id: string, requestId: string): Promise<SignMemberView> {
    const users = await this.repo.listTenantUsers(tenant_id);
    const u = users.find((x) => x.user_id === user_id);
    if (u === undefined) throw new AramoError('NOT_FOUND', 'No member with that id in this organization', 404, { requestId });
    return memberView(u);
  }
}
