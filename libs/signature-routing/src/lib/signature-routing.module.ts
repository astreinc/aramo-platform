import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { SignatureRoutingRepository } from './signature-routing.repository.js';

@Module({
  providers: [PrismaService, SignatureRoutingRepository],
  exports: [SignatureRoutingRepository],
})
export class SignatureRoutingStoreModule {}
