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
} from '@aramo/identity';

import { SenderContextService } from './sender-context.service.js';

// Sign Unified Product S-1 — Sign member administration (directive §4.3.3/§4.3.4).
// A holder of esign:member:manage assigns or removes the ONE Sign role of an
// organization member. Only the Sign role changes: every other role the member
// holds (organization, ATS) is carried over untouched. The tenant, the acting
// user and the target membership come only from the verified auth context and
// the server-side membership lookup.
//
// Rules (fail closed):
//   - BUSINESS tenants only (a PERSONAL account has no members to administer).
//   - the target must be a member of the caller's own tenant (else 404).
//   - only a current Sign Owner may grant or remove the Sign Owner role.
//   - the last Sign Owner cannot be removed or demoted (an organization that has
//     never had a Sign Owner — e.g. an operator-arranged plan — may have none).
//   - assignability (the tenant holds `esign`), the role-union check and the
//     authz_version bump are IdentityService.replaceMembershipRoles' (one home).

const PRECEDENCE: Record<EsignRoleKey, number> = { esign_owner: 4, esign_admin: 3, esign_sender: 2, esign_viewer: 1 };

export interface SignMemberView {
  user_id: string;
  email: string;
  display_name: string | null;
  active: boolean;
  sign_role: EsignRoleKey | null;
  sign_role_display: string | null;
}

function signRoleOf(keys: readonly string[]): EsignRoleKey | null {
  let best: EsignRoleKey | null = null;
  for (const k of keys) {
    if (isEsignRoleKey(k) && (best === null || PRECEDENCE[k] > PRECEDENCE[best])) best = k;
  }
  return best;
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
      items: users.map((u) => {
        const role = signRoleOf(u.role_keys);
        return {
          user_id: u.user_id,
          email: u.email,
          display_name: u.display_name,
          active: u.is_active,
          sign_role: role,
          sign_role_display: role === null ? null : ESIGN_ROLE_DISPLAY[role],
        };
      }),
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
    const callerMembership = await this.repo.findMembership({ user_id: auth.sub, tenant_id: auth.tenant_id });
    const callerKeys = callerMembership === null ? [] : await this.identity.findRoleKeysForMembership(callerMembership.id);
    const callerIsOwner = callerKeys.includes('esign_owner');

    const before = await this.identity.findRoleKeysForMembership(target.id);
    const current = signRoleOf(before);
    const next = requested as EsignRoleKey | null;
    if (current === next) return this.view(user_id, auth.tenant_id, requestId);

    if ((current === 'esign_owner' || next === 'esign_owner') && !callerIsOwner) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Only a Sign Owner can grant or remove the Sign Owner role', 403, {
        requestId,
        details: { reason: 'owner_role_requires_owner' },
      });
    }
    if (current === 'esign_owner') {
      const users = await this.repo.listTenantUsers(auth.tenant_id);
      const owners = users.filter((u) => u.is_active && u.role_keys.includes('esign_owner'));
      if (owners.length <= 1) {
        throw new AramoError('ESIGN_LAST_OWNER', 'The organization must keep at least one Sign Owner', 409, {
          requestId,
          details: { reason: 'last_owner' },
        });
      }
    }

    const role_keys = [...before.filter((k) => !isEsignRoleKey(k)), ...(next === null ? [] : [next])];
    const role_ids = await this.identity.resolveRoleIdsByKeys(role_keys);
    await this.identity.replaceMembershipRoles({ membership_id: target.id, tenant_id: auth.tenant_id, role_keys, role_ids, request_id: requestId });
    this.log.log(
      `sign role change tenant=${auth.tenant_id} actor=${auth.sub} target=${user_id} from=${current ?? 'none'} to=${next ?? 'none'} request=${requestId}`,
    );
    return this.view(user_id, auth.tenant_id, requestId);
  }

  private async view(user_id: string, tenant_id: string, requestId: string): Promise<SignMemberView> {
    const users = await this.repo.listTenantUsers(tenant_id);
    const u = users.find((x) => x.user_id === user_id);
    if (u === undefined) throw new AramoError('NOT_FOUND', 'No member with that id in this organization', 404, { requestId });
    const role = signRoleOf(u.role_keys);
    return { user_id: u.user_id, email: u.email, display_name: u.display_name, active: u.is_active, sign_role: role, sign_role_display: role === null ? null : ESIGN_ROLE_DISPLAY[role] };
  }
}
