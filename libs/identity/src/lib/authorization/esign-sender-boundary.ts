import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import type { Request } from 'express';

import { ESIGN_SENDER_SCOPE_KEY } from '../dto/role.dto.js';

// IC-3 PR-8 — the Sign SENDER authorization boundary (IC-0 §G rows "Subscribed
// products" / "Product domain actions"; PX-V1 §10 PX-3 + §11 three auth zones).
//
// The authenticated sender surface (`v1/sign/sender/*` on sign-service — PX-V1
// §8 D-2) does NOT exist at the PR-8 baseline and PR-8 does not invent it (a
// sender API without `apps/esign-web`, the esign.aramo.ai ingress and the
// sign-service → @aramo/auth wiring would be a dark, untestable product
// surface). What PR-8 establishes instead is the boundary that surface MUST
// mount, owned by the identity substrate so the rule has exactly one home:
//
//   @EsignSenderBoundary()  ≡  @UseGuards(JwtAuthGuard,            — WHO (shared SSO identity)
//                                         EsignSenderConsumerGuard, — WHICH product credential
//                                         EntitlementGuard,         — tenant `sign` capability (backend-authoritative)
//                                         RolesGuard)               — effective `sign:envelope:send`
//                              @RequireCapability('sign')
//                              @RequireScopes('sign:envelope:send')
//
// Layer by layer, fail closed:
//   1. JwtAuthGuard — the shared-identity token; the platform tripwire already
//      refuses a `platform` (super_admin) token on any non-/platform route.
//   2. EsignSenderConsumerGuard — ONLY the `sign` consumer credential may send.
//      A recruiter/ingestion token (even one whose principal also holds a Sign
//      role) is refused here, independently of the PR-6 namespace filter that
//      already strips esign:* from ATS-family consumers (defense in depth; no
//      bypass of PR-6 — the guard narrows, never widens).
//   3. EntitlementGuard — the tenant must hold `sign` (ATS-only tenant → 403
//      TENANT_CAPABILITY_NOT_ENTITLED; a removed entitlement is refused on the
//      very next request because the read is live).
//   4. RolesGuard — the principal's EFFECTIVE scopes (resolved server-side by
//      authz_version, never from the token) must include sign:envelope:send:
//      sign_viewer, ats_admin, every other ATS role → 403 INSUFFICIENT_PERMISSIONS.
//      A role revocation bumps the principal's authz_version inside the same
//      transaction (identity.repository replaceMembershipRoles), so a cached
//      scope snapshot or an already-issued token cannot restore the authority.
//
// `evaluateEsignSenderAuthorization` is the same decision as a pure function —
// the adapter-side / non-HTTP form (and the unit-testable specification of the
// guard chain's order of refusal).
//
// Activation dependency (documented, NOT built here — PX-V1 §8/§10, IC-0 §J):
//   apps/esign-web (D-4) · `v1/sign/sender/*` controller on sign-service mounting
//   @EsignSenderBoundary() (sign-service → @aramo/auth + @aramo/entitlement +
//   @aramo/authorization or @aramo/identity, 3-place wiring) · esign.aramo.ai nginx
//   block + env + Cognito callback (PRODUCT host class leaves DARK: host-binding.ts).

export type EsignSenderDenialReason =
  | 'consumer_not_esign'
  | 'tenant_not_entitled'
  | 'sender_scope_missing';

export type EsignSenderVerdict =
  | { ok: true }
  | { ok: false; reason: EsignSenderDenialReason };

export function evaluateEsignSenderAuthorization(input: {
  consumer: string | undefined;
  tenantCapabilities: ReadonlySet<string>;
  // The principal's EFFECTIVE scopes for this consumer (post PR-6 filter).
  scopes: readonly string[];
}): EsignSenderVerdict {
  if (input.consumer !== 'sign') return { ok: false, reason: 'consumer_not_esign' };
  if (!input.tenantCapabilities.has('sign')) return { ok: false, reason: 'tenant_not_entitled' };
  if (!input.scopes.includes(ESIGN_SENDER_SCOPE_KEY)) return { ok: false, reason: 'sender_scope_missing' };
  return { ok: true };
}

// Layer 2 — the product-credential check. Runs AFTER JwtAuthGuard (authContext
// established) and BEFORE the tenant/scope guards so the refusal reason is the
// most specific one: a non-esign consumer never learns whether the tenant is
// entitled or which scope it lacks.
@Injectable()
export class EsignSenderConsumerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContextType; requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';
    const authContext = request.authContext;
    if (authContext === undefined) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Authorization context not established', 403, {
        requestId,
        details: { reason: 'auth_context_missing' },
      });
    }
    if (authContext.consumer_type !== 'sign') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Sign sender actions require the esign product credential', 403, {
        requestId,
        details: { reason: 'consumer_not_esign', consumer_type: authContext.consumer_type },
      });
    }
    return true;
  }
}

// The composed boundary a Sign sender route mounts. Method- or class-level.
// PX-1 — the route's required Sign scope is a parameter (default unchanged:
// sign:envelope:send). Read routes pass sign:envelope:read, draft authoring
// passes sign:envelope:create; the consumer + capability layers are identical.
export function EsignSenderBoundary(scope: string = ESIGN_SENDER_SCOPE_KEY): MethodDecorator & ClassDecorator {
  return applyDecorators(
    UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard),
    RequireCapability('sign'),
    RequireScopes(scope),
  );
}
