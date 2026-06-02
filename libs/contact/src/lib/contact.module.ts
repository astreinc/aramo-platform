import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CompanyModule } from '@aramo/company';
import { EntitlementModule } from '@aramo/entitlement';

import { ContactController } from './contact.controller.js';
import { ContactRepository } from './contact.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// ContactModule — PR-A2 Gate 5 ATS Batch 1.
//
// Leaf import set (lint:nx-boundaries — directional contact -> company,
// no cycle): the CompanyModule import is the only domain-lib edge; it
// is unidirectional (company does NOT import contact). The cross-lib
// type the contact uses (CompanyRepository) is the same logical
// boundary the create path validates against.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, CompanyModule],
  controllers: [ContactController],
  providers: [PrismaService, ContactRepository],
  exports: [ContactRepository],
})
export class ContactModule {}
