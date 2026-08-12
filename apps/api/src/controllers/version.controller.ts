import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ReleaseIdentityService } from '@aramo/common';

// GLH-2-A (ATS Go-Live Hardening Charter v1.5 / GLH-2 Release Integrity) — the
// running-release identity surface. It reports ONLY the build-stamped source
// revision so a running image can be tied back to its exact commit (R9).
//
// UNGUARDED by design: no session, no PII, no database. There is no global
// APP_GUARD in this app, so a guardless controller is genuinely anonymous (see
// apps/api/src/talent-identity/portal-notice.controller.ts). It is NOT a
// product/business API and NOT observability (GLH-3) — it is classified IZ
// (infrastructure/health/ops) in ci/config/api-surface-manifest.json (the first
// live IZ route), so it carries no OpenAPI/contract-parity obligation.
@Controller('version')
export class VersionController {
  constructor(private readonly releaseIdentity: ReleaseIdentityService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  version(): { revision: string } {
    return { revision: this.releaseIdentity.revision() };
  }
}
