import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { EsignService } from './esign.service.js';
import { EVIDENCE_MANIFEST_SIGNER_PORT, SoftwareEvidenceManifestSigner } from './ports/evidence-manifest-signer.port.js';

// DOC-3 — the ATS-neutral E-Sign domain module. Binds the DOC-3 SOFTWARE
// evidence signer by default; the apps/esign-service composition root may
// override EVIDENCE_MANIFEST_SIGNER_PORT with the KMS signer in DOC-4, and binds
// SIGNING_NOTIFICATION_PORT to a MailerPort-backed adapter. No ATS/cip import.
@Module({
  providers: [
    PrismaService,
    EsignRepository,
    EsignService,
    { provide: EVIDENCE_MANIFEST_SIGNER_PORT, useClass: SoftwareEvidenceManifestSigner },
  ],
  exports: [PrismaService, EsignRepository, EsignService],
})
export class EsignModule {}
