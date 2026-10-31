import { applyDecorators, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { EsignSenderConsumerGuard } from '@aramo/identity';

import { toHttp } from '../esign-http.controller.js';
import { SignReportService } from '../personal/sign-report.service.js';

import { RecipientInboxService } from './recipient-inbox.service.js';

// Sign Unified Product S-7 — the recipient inbox (/v1/sign/inbox/*). A RECIPIENT
// right, not a tenant permission: any signed-in Aramo Sign user (esign consumer)
// may use it, with or without a Sign role — everything is limited to the user's
// own recipient bindings (the service keys every read by the token's subject).
export function RecipientInboxBoundary(): MethodDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, EsignSenderConsumerGuard));
}

@Controller('v1/sign/inbox')
@UseFilters(AramoExceptionFilter)
export class RecipientInboxController {
  constructor(
    private readonly inbox: RecipientInboxService,
    // Amendment M-A7 §5.2 (R-11) — "Report" from the app's received-envelope view.
    private readonly reports: SignReportService,
  ) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get()
  @RecipientInboxBoundary()
  list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Query('folder') folder?: string) {
    return this.run(requestId, () => this.inbox.list(auth, folder, requestId));
  }

  @Post('claim')
  @HttpCode(HttpStatus.CREATED)
  @RecipientInboxBoundary()
  claim(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { token?: unknown }) {
    return this.run(requestId, () => this.inbox.claim(auth, body ?? {}, requestId));
  }

  @Post(':id/sign')
  @HttpCode(HttpStatus.OK)
  @RecipientInboxBoundary()
  sign(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.inbox.sign(auth, id, requestId));
  }

  @Post(':id/signed-copy')
  @HttpCode(HttpStatus.OK)
  @RecipientInboxBoundary()
  signedCopy(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.inbox.signedCopy(auth, id, requestId));
  }

  // Amendment M-A7 §5.2 (R-11) — the same report flow as the emailed "Report this
  // email" link, keyed by the user's own inbox item (no signing token travels).
  @Post(':id/report')
  @HttpCode(HttpStatus.ACCEPTED)
  @RecipientInboxBoundary()
  report(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { reason?: unknown; note?: unknown }) {
    return this.run(requestId, () => this.reports.submitFromInbox(auth.sub, id, body ?? {}, requestId));
  }

  // Retention and Purge directive (ebd41d99) R-10 — the DocuSign "Deleted" folder (binding
  // kept, restorable); `DELETE :id` below still removes the binding itself.
  @Post(':id/delete')
  @HttpCode(HttpStatus.OK)
  @RecipientInboxBoundary()
  deleteForMe(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.inbox.deleteForMe(auth, id, requestId));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RecipientInboxBoundary()
  restoreForMe(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.inbox.restoreForMe(auth, id, requestId));
  }

  @Delete(':id')
  @RecipientInboxBoundary()
  remove(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.inbox.remove(auth, id, requestId));
  }
}
