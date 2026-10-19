import { Module } from '@nestjs/common';
import { MailerModule } from '@aramo/mailer';

import { PlatformModule } from '../platform/platform.module.js';

import { SignSignupController } from './sign-signup.controller.js';
import { SignupBudget, SignSignupService } from './sign-signup.service.js';

// Aramo Sign launch — public self-service signup. Reuses the platform
// provisioning saga (PlatformInvitationService, exported by PlatformModule) and
// the shared identity store; MailerModule sends the verification email.
@Module({
  imports: [PlatformModule, MailerModule],
  controllers: [SignSignupController],
  providers: [SignSignupService, SignupBudget],
})
export class SignupModule {}
