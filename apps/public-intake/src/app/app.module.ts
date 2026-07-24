import { Module } from '@nestjs/common';

import { IntakeModule } from './intake/intake.module.js';

@Module({
  imports: [IntakeModule],
})
export class AppModule {}
