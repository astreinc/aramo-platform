import { DynamicModule, Module, ModuleMetadata, Provider } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { EsignService } from './esign.service.js';
import { EVIDENCE_MANIFEST_SIGNER_PORT, SoftwareEvidenceManifestSigner } from './ports/evidence-manifest-signer.port.js';

// DOC-3/DOC-4 — the ATS-neutral E-Sign domain module. The composition root
// (apps/esign-service) supplies the EvidenceManifestSignerPort via forRoot:
// DOC-3 ships the SOFTWARE signer as the default; DOC-4 rebinds it to the
// KMS-backed signer, env-gated, WITHOUT libs/esign gaining any provider SDK.
// The composition root also binds SIGNING_NOTIFICATION_PORT + the executed-
// document producer (EXECUTION_PRODUCER_PORT). No ATS/cip import.
const DEFAULT_EVIDENCE_SIGNER: Provider = {
  provide: EVIDENCE_MANIFEST_SIGNER_PORT,
  useClass: SoftwareEvidenceManifestSigner,
};

@Module({})
export class EsignModule {
  static forRoot(opts?: {
    evidenceSigner?: Provider;
    extraProviders?: Provider[];
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: EsignModule,
      imports: opts?.imports ?? [],
      providers: [
        PrismaService,
        EsignRepository,
        EsignService,
        opts?.evidenceSigner ?? DEFAULT_EVIDENCE_SIGNER,
        ...(opts?.extraProviders ?? []),
      ],
      exports: [PrismaService, EsignRepository, EsignService],
    };
  }
}
