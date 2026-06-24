import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { IdentityService, type MeView } from '@aramo/identity';

// Aramo-Identity-Me-Endpoint-UserMenu-Directive-v1_0 — GET /v1/me.
//
// The "who am I" self-read that feeds the shell's top-right user menu, the org-
// context label, and the rail footer. It is the DISPLAY companion to the lean
// session JWT: the token carries authorization (sub, consumer_type, tenant_id,
// scopes) and stays frozen at 6 fields (openapi/auth.yaml, additionalProperties
// false); this endpoint carries the human display data the token deliberately
// omits — the caller's name + email, their role display names, and the tenant
// org label. READS ONLY: no token issuance, no scope mutation, no membership
// write (the normal-merge premise — it never touches the auth surface).
//
// Lives in apps/api (NOT auth-service, NOT libs/identity): it is a plain tenant
// read endpoint composed on IdentityService (the same placement as
// AssignableUsersController), not part of the token-issuance surface.
//
// SCOPING: implicit-self. Both the user_id (authContext.sub) and tenant_id
// (authContext.tenant_id) come ONLY from the JWT — no URL/body/query override —
// so a caller can read only their OWN identity in their OWN tenant. A member of
// tenant A can never resolve tenant B (the repo keys on the composite
// (user_id, tenant_id); a missing membership → 404).
//
// GATE: the LIGHTEST read gate. JwtAuthGuard (authenticated) + the `core`
// tenant-axis capability — but NO @RequireScopes. /me must answer for EVERY
// authenticated tenant member regardless of role (an admin, a recruiter, an
// auditor), so it cannot be gated behind any one role's scope; RolesGuard
// no-ops without @RequireScopes (roles.guard.ts), and the self-read exposes
// only the caller's own data, so no scope narrowing is needed or correct.
@Controller('v1/me')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class MeController {
  constructor(private readonly identity: IdentityService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async me(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<MeView> {
    const view = await this.identity.getMe({
      user_id: authContext.sub,
      tenant_id: authContext.tenant_id,
    });
    if (view === null) {
      throw new AramoError('NOT_FOUND', 'Membership not found', 404, {
        requestId,
        details: { tenant_id: authContext.tenant_id },
      });
    }
    return view;
  }
}
