import { Controller, Get, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { signatureActorFrom } from './signature-actor.js';
import { SignatureAvailabilityService, type SignatureAvailability } from './signature-availability.service.js';

// Multi-Provider directive §D/§H — the backend-owned read the recruiter surfaces
// render from (send buttons, "Requires Aramo Sign", allowance used/remaining and
// the renewal date). Advisory only: every send re-checks immediately before it
// happens. Judged for the calling user (their document permissions included).
@Controller('v1/document-signing')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class SignatureAvailabilityController {
  constructor(private readonly availability: SignatureAvailabilityService) {}

  @Get('availability')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async read(@AuthContext() auth: AuthContextType, @Req() req: Request): Promise<SignatureAvailability> {
    // Addendum S6 — over the Sign API transport, availability is asked with the user's delegation.
    return this.availability.evaluate(auth.tenant_id, auth.scopes, signatureActorFrom(req));
  }
}
