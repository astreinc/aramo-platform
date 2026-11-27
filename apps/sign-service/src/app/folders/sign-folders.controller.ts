import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';

import { toHttp } from '../esign-http.controller.js';
import { RecipientInboxBoundary } from '../inbox/recipient-inbox.controller.js';

import { SignFoldersService } from './sign-folders.service.js';

// SIGN-FREE-PARITY-1 S7 (FP-R8) — the signed-in user's own folders. Like the inbox, a right of
// the user (not a tenant permission): any signed-in Aramo Sign user may keep folders, for what
// they sent and for what they received. Moving an envelope in or out is on the sender route
// (PUT/DELETE v1/sign/sender/envelopes/:id/folder) and the inbox route
// (PUT/DELETE v1/sign/inbox/:id/folder), which check the user can see the item first.
@Controller('v1/sign/folders')
@UseFilters(AramoExceptionFilter)
export class SignFoldersController {
  constructor(private readonly folders: SignFoldersService) {}

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
    return this.run(requestId, () => this.folders.list(auth));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RecipientInboxBoundary()
  create(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { name?: unknown }) {
    return this.run(requestId, () => this.folders.create(auth, body ?? {}, requestId));
  }

  @Patch(':id')
  @RecipientInboxBoundary()
  rename(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { name?: unknown }) {
    return this.run(requestId, () => this.folders.rename(auth, id, body ?? {}, requestId));
  }

  @Delete(':id')
  @RecipientInboxBoundary()
  remove(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.folders.remove(auth, id, requestId));
  }
}
