import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Put, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';

import { RecipientInboxBoundary } from '../../inbox/recipient-inbox.controller.js';
import { senderHttp } from '../../sender/envelope-contracts.js';

import { SavedSignatureService } from './saved-signature.service.js';

// Aramo Sign Mobile (M-A3 §4) — the signed-in user's saved signature and initials
// (/v1/sign/me/signature, /v1/sign/me/initials). Per-user convenience data for
// SIGNING, which any Aramo Sign user does as a recipient — so, like the inbox, the
// boundary is the session + the `sign` consumer (no Sign role scope), and every
// read and write is keyed by the token's (tenant, subject). Web and mobile alike.
@Controller('v1/sign/me')
@UseFilters(AramoExceptionFilter)
export class SavedSignatureController {
  constructor(private readonly saved: SavedSignatureService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw senderHttp(e, requestId);
    }
  }

  @Get('signature')
  @RecipientInboxBoundary()
  get(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.saved.get(auth));
  }

  @Put('signature')
  @RecipientInboxBoundary()
  putSignature(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, () => this.saved.put(auth, 'signature', body, requestId));
  }

  @Delete('signature')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RecipientInboxBoundary()
  deleteSignature(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.saved.remove(auth, 'signature'));
  }

  @Put('initials')
  @RecipientInboxBoundary()
  putInitials(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, () => this.saved.put(auth, 'initials', body, requestId));
  }

  @Delete('initials')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RecipientInboxBoundary()
  deleteInitials(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.saved.remove(auth, 'initials'));
  }
}
