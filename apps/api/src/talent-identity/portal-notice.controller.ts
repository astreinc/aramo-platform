import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { NOTICE_TEXT_CURRENT_VERSION, renderPlatformNotice } from '@aramo/consent';

// Portal P4 P4a (Aramo-Portal-P4-Directive-v1_0-LOCKED §PR-1.1, D-5) — the PUBLIC
// platform-notice read. "Always available" (D-5): a person must be able to read
// the notice with NO session, before or without signing in.
//
// Unguarded BY CONSTRUCTION — a SEPARATE controller with NO `@UseGuards` (the
// PortalAuthController precedent). It deliberately does NOT live on PortalController,
// whose class-level `@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)` +
// `@RequireCapability('portal')` are unconditional and there is no `@Public()`
// escape hatch in this codebase (substrate-confirmed). There is no global
// APP_GUARD, so a guardless controller is genuinely public.
//
// Serves the rendered CURRENT notice version — the same bytes the dormant-notice
// email delivers (D-5). No PII, no session, no inputs: a static disclosure.
@Controller('v1/portal/notice')
export class PortalNoticeController {
  @Get()
  @HttpCode(HttpStatus.OK)
  getNotice(): { version: string; text: string } {
    return {
      version: NOTICE_TEXT_CURRENT_VERSION,
      text: renderPlatformNotice(NOTICE_TEXT_CURRENT_VERSION),
    };
  }
}
