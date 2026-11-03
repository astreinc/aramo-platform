import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { personalSignupMode } from '@aramo/identity';
import type { Request } from 'express';

import {
  PersonalSignupService,
  type PersonalCompleteResult,
  type PersonalNextStep,
  type PersonalTermsDocument,
  type PersonalTermsText,
} from './personal-signup.service.js';

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

  // Aramo-Sign-Mobile-Amendment-M-A11 §2.2 — the exact text of an effective Personal
  // document (native terms screen); 404 for anything else.
  @Get('terms/:key/:version')
  termsText(@RequestId() requestId: string, @Param('key') key: string, @Param('version') version: string): PersonalTermsText {
    this.gate(requestId);
    const doc = this.signup.termsText(key, version);
    if (doc === null) throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId, details: { reason: 'legal_document_not_found' } });
    return doc;
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
  complete(@Req() req: Request, @RequestId() requestId: string, @Body() body: { signup_id?: unknown; accept?: unknown; client?: unknown }): Promise<PersonalCompleteResult> {
    this.gate(requestId);
    return this.signup.complete({
      signup_id: body?.signup_id,
      accept: body?.accept,
      client: body?.client,
      ip: req.ip ?? 'unknown',
      user_agent: req.get('user-agent') ?? null,
      request_id: requestId,
    });
  }
}
