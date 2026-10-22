import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { personalSignupMode } from '@aramo/identity';
import type { Request } from 'express';

import { PersonalSignupService, type PersonalCompleteResult, type PersonalNextStep, type PersonalTermsDocument } from './personal-signup.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §3 / §10 — the PUBLIC
// (session-less) Personal (Free) signup, reached on sign.aramo.ai through nginx
// (/v1/signup/sign/ → platform-admin). Every route answers 404 unless
// SIGN_PERSONAL_SIGNUP_MODE is `invite` or `open` (ships `off`). The client IP is
// the one trusted proxy hop (applyTrustProxy in main.ts).

@Controller('v1/signup/sign/personal')
@UseFilters(AramoExceptionFilter)
export class PersonalSignupController {
  constructor(private readonly signup: PersonalSignupService) {}

  private gate(requestId: string): void {
    if (personalSignupMode() === 'off') throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
  }

  @Get('terms')
  terms(@RequestId() requestId: string): { documents: PersonalTermsDocument[] | null } {
    this.gate(requestId);
    return { documents: this.signup.currentTerms() };
  }

  @Post('start')
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Req() req: Request, @RequestId() requestId: string, @Body() body: Record<string, unknown>): Promise<{ signup_id: string }> {
    this.gate(requestId);
    return this.signup.start({ ...(body ?? {}), ip: req.ip ?? 'unknown', request_id: requestId });
  }

  @Post('resend-email')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendEmail(@Req() req: Request, @RequestId() requestId: string, @Body() body: { signup_id?: unknown }): Promise<{ accepted: true }> {
    this.gate(requestId);
    await this.signup.resendEmail({ signup_id: body?.signup_id, ip: req.ip ?? 'unknown', request_id: requestId });
    return { accepted: true };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@RequestId() requestId: string, @Body() body: { signup_id?: unknown; code?: unknown }): Promise<{ next: PersonalNextStep }> {
    this.gate(requestId);
    return this.signup.verifyEmail({ signup_id: body?.signup_id, code: body?.code, request_id: requestId });
  }

  @Post('phone/send')
  @HttpCode(HttpStatus.OK)
  sendPhone(@RequestId() requestId: string, @Body() body: { signup_id?: unknown }): Promise<{ sent: boolean }> {
    this.gate(requestId);
    return this.signup.sendPhoneCode({ signup_id: body?.signup_id, request_id: requestId });
  }

  @Post('phone/verify')
  @HttpCode(HttpStatus.OK)
  verifyPhone(@RequestId() requestId: string, @Body() body: { signup_id?: unknown; code?: unknown }): Promise<{ next: 'terms' }> {
    this.gate(requestId);
    return this.signup.verifyPhone({ signup_id: body?.signup_id, code: body?.code, request_id: requestId });
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  complete(@Req() req: Request, @RequestId() requestId: string, @Body() body: { signup_id?: unknown; accept?: unknown }): Promise<PersonalCompleteResult> {
    this.gate(requestId);
    return this.signup.complete({ signup_id: body?.signup_id, accept: body?.accept, ip: req.ip ?? 'unknown', request_id: requestId });
  }
}
