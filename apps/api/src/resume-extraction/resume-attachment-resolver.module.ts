import { Global, Module } from '@nestjs/common';
import { AttachmentModule, AttachmentResumeResolver } from '@aramo/attachment';
import { RESUME_ATTACHMENT_RESOLVER } from '@aramo/talent-record';

// TALENT-INTEL-1 (TI-1B port / TI-1D-C consumer) — the composition-root binding of
// talent-record's RESUME_ATTACHMENT_RESOLVER token to the concrete
// AttachmentResumeResolver (in @aramo/attachment). This is the ONLY place the two
// are joined: libs/talent-record depends solely on the port interface and never
// imports attachment (no nx cycle; attachment → talent-record is the real edge).
// @Global so the TalentRecordController (declared in its own module) can inject the
// token for the résumé-editions POST ingestion and the EDIT re-extraction path.
// A STRING token (not a bare class) — avoids the non-strict app.get bare-class
// provider-collision trap.
@Global()
@Module({
  imports: [AttachmentModule],
  providers: [
    { provide: RESUME_ATTACHMENT_RESOLVER, useExisting: AttachmentResumeResolver },
  ],
  exports: [RESUME_ATTACHMENT_RESOLVER],
})
export class ResumeAttachmentResolverModule {}
