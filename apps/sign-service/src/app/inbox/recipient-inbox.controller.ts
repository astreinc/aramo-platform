import { applyDecorators, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { EsignSenderConsumerGuard } from '@aramo/identity';

import { toHttp } from '../esign-http.controller.js';

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
  constructor(private readonly inbox: RecipientInboxService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get()
  @RecipientInboxBoundary()
  list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.inbox.list(auth));
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

  @Delete(':id')
  @RecipientInboxBoundary()
  remove(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.inbox.remove(auth, id, requestId));
  }
}
