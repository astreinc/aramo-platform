import { SESv2Client } from '@aws-sdk/client-sesv2';
import { Module } from '@nestjs/common';

import { IntakeController } from './intake.controller.js';
import { loadIntakeConfig } from './intake.config.js';
import { IntakeMailerService } from './intake-mailer.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { INTAKE_SES_CLIENT } from './tokens.js';

@Module({
  controllers: [IntakeController],
  providers: [
    IntakeMailerService,
    RateLimitService,
    {
      // Lazily-regioned SESv2 client (SDK default credential chain). Tests
      // override this token with a fake { send }.
      provide: INTAKE_SES_CLIENT,
      useFactory: (): SESv2Client =>
        new SESv2Client({ region: loadIntakeConfig().sesRegion }),
    },
  ],
})
export class IntakeModule {}
