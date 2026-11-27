import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { EsignSenderConsumerGuard } from '@aramo/identity';

import { SenderPhoneStepUpService, type SenderStepUpSent, type SenderStepUpStatus } from './sender-phone-step-up.service.js';

// SIGN-FREE-PARITY-1 S2 — the sender's own phone step-up (v1/sign/personal/step-up).
//
//   GET  status  { available, required, phone_masked }
//   POST send    { phone? }  → { sent, phone_masked, expires_in_seconds, resend_after_seconds }
//   POST verify  { code }    → { verified: true }
//
// Same boundary as v1/sign/account: an Aramo SSO `sign` session of a tenant entitled to
// `sign`; the tenant and user come only from the verified auth context. Dark behind
// SIGN_SENDER_PHONE_STEP_UP (send / verify answer 404 step_up_not_available while off).

function StepUpBoundary(): MethodDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard), RequireCapability('sign'));
}

@Controller('v1/sign/personal/step-up')
@UseFilters(AramoExceptionFilter)
export class SenderPhoneStepUpController {
  constructor(private readonly stepUp: SenderPhoneStepUpService) {}

  @Get('status')
  @StepUpBoundary()
  async status(@AuthContext() auth: AuthContextType): Promise<SenderStepUpStatus> {
    return this.stepUp.status(auth);
  }

  @Post('send')
  @HttpCode(HttpStatus.OK)
  @StepUpBoundary()
  async send(@AuthContext() auth: AuthContextType, @Body() body: { phone?: unknown }, @RequestId() requestId: string): Promise<SenderStepUpSent> {
    return this.stepUp.send(auth, body, requestId);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @StepUpBoundary()
  async verify(@AuthContext() auth: AuthContextType, @Body() body: { code?: unknown }, @RequestId() requestId: string): Promise<{ verified: true }> {
    return this.stepUp.verify(auth, body, requestId);
  }
}
