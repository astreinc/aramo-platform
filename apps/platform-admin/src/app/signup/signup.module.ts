import { Module } from '@nestjs/common';
import { EntitlementModule } from '@aramo/entitlement';
import { MailerModule } from '@aramo/mailer';

import { PlatformModule } from '../platform/platform.module.js';

import { SignSignupController } from './sign-signup.controller.js';
import { PersonalSignupController } from './personal-signup.controller.js';
import { PersonalSignupService } from './personal-signup.service.js';
import { AddressSuggestService } from './address-suggest.service.js';
import { SignupBudget, SignSignupService } from './sign-signup.service.js';

// Aramo Sign launch — public self-service signup. Cognito-free owner
// provisioning (Aramo-Sign-Signup-Federated-Owner / AUTH-SIGNIN-1): the shared
// identity store (exported by PlatformModule), the entitlement store, and
// MailerModule for the verification and "organization ready" emails.
@Module({
  imports: [PlatformModule, EntitlementModule, MailerModule],
  controllers: [SignSignupController, PersonalSignupController],
  // Sign Personal (Free) Launch v1.1 — the public Personal signup (dark unless SIGN_PERSONAL_SIGNUP_MODE).
  providers: [SignSignupService, SignupBudget, AddressSuggestService, PersonalSignupService],
})
export class SignupModule {}
