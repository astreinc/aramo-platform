import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import type { Request } from 'express';

import { AddressSuggestService, type AddressSuggestResult } from './address-suggest.service.js';
import { SignSignupService, signupEnabled } from './sign-signup.service.js';

// Aramo Sign launch — the PUBLIC (session-less) self-service signup surface,
// reached on esign.aramo.ai through nginx (/v1/signup/sign/ → platform-admin).
// No guard by design: authenticity of `complete` is possession of the emailed
// link. While SIGN_PUBLIC_SIGNUP_ENABLED is not 1 every route answers 404, as if
// it did not exist. The client IP comes from the one trusted proxy hop
// (applyTrustProxy in main.ts).

@Controller('v1/signup/sign')
@UseFilters(AramoExceptionFilter)
export class SignSignupController {
  constructor(
    private readonly signup: SignSignupService,
    private readonly addresses: AddressSuggestService,
  ) {}

  private gate(requestId: string): void {
    if (!signupEnabled()) throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
  }

  // A1 — the terms a signup must accept (null while none is approved).
  @Get('terms')
  terms(@RequestId() requestId: string): { terms: { version: string; url: string } | null } {
    this.gate(requestId);
    return { terms: this.signup.currentTerms() };
  }

  @Post('start')
  @HttpCode(HttpStatus.ACCEPTED)
  async start(
    @Req() req: Request,
    @RequestId() requestId: string,
    @Body() body: { email?: unknown; organization_name?: unknown; display_name?: unknown; accept_terms?: unknown },
  ): Promise<{ accepted: true }> {
    this.gate(requestId);
    await this.signup.start({ ...(body ?? {}), ip: req.ip ?? 'unknown', request_id: requestId });
    return { accepted: true };
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@RequestId() requestId: string, @Body() body: { token?: unknown }) {
    this.gate(requestId);
    return this.signup.preview(body?.token, requestId);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  complete(@Req() req: Request, @RequestId() requestId: string, @Body() body: { token?: unknown; organization_name?: unknown; organization?: unknown }) {
    this.gate(requestId);
    return this.signup.complete({ ...(body ?? {}), ip: req.ip ?? 'unknown', request_id: requestId });
  }

  // Sign Signup Amendment A1 (LOCKED) §2.3 — address search for the
  // organization-details step. Only with a live, unprovisioned signup link
  // (404 otherwise, like every other route); fails open to manual entry.
  @Post('address/suggest')
  @HttpCode(HttpStatus.OK)
  async suggestAddress(
    @Req() req: Request,
    @RequestId() requestId: string,
    @Body() body: { token?: unknown; text?: unknown },
  ): Promise<AddressSuggestResult> {
    this.gate(requestId);
    await this.signup.assertLiveLink(body?.token, requestId);
    return this.addresses.suggest({ text: body?.text, token: body!.token as string, ip: req.ip ?? 'unknown' });
  }
}
