import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { SignatureAvailabilityController } from './signature-availability.controller.js';
import { SignatureRoutingModule } from './signature-routing.module.js';

@Module({
  // JwtAuthGuard + RolesGuard + EntitlementGuard — the ATS three-axis guard chain.
  imports: [AuthModule, AuthorizationModule, EntitlementModule, SignatureRoutingModule],
  controllers: [SignatureAvailabilityController],
})
export class SignatureAvailabilityHttpModule {}
