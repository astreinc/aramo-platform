import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';

import { RecipientInboxBoundary } from '../../inbox/recipient-inbox.controller.js';
import { senderHttp } from '../../sender/envelope-contracts.js';
import { SignMeProfileService } from '../profile/sign-me-profile.service.js';

import { SavedSignatureService } from './saved-signature.service.js';

// Aramo Sign Mobile (M-A3 §4) — the signed-in user's saved signature and initials
// (/v1/sign/me/signature, /v1/sign/me/initials). Per-user convenience data for
// SIGNING, which any Aramo Sign user does as a recipient — so, like the inbox, the
// boundary is the session + the `sign` consumer (no Sign role scope), and every
// read and write is keyed by the token's (tenant, subject). Web and mobile alike.
// Aramo Sign Mobile M-A12 §2 W1-E — the same per-user zone also serves the Sign profile
// (/v1/sign/me/profile), settings (/v1/sign/me/settings) and "Report app issue"
// (/v1/sign/me/app-issues, 202, rate limited).
@Controller('v1/sign/me')
@UseFilters(AramoExceptionFilter)
export class SavedSignatureController {
  constructor(
    private readonly saved: SavedSignatureService,
    private readonly me: SignMeProfileService,
  ) {}

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

  // ── M-A12 W1-E — profile, settings, app issues ─────────────────────────────

  @Get('profile')
  @RecipientInboxBoundary()
  getProfile(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.me.getProfile(auth));
  }

  @Put('profile')
  @RecipientInboxBoundary()
  putProfile(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, () => this.me.putProfile(auth, body, requestId));
  }

  @Get('settings')
  @RecipientInboxBoundary()
  getSettings(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.me.getSettings(auth));
  }

  @Put('settings')
  @RecipientInboxBoundary()
  putSettings(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, () => this.me.putSettings(auth, body, requestId));
  }

  @Post('app-issues')
  @HttpCode(HttpStatus.ACCEPTED)
  @RecipientInboxBoundary()
  reportIssue(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: unknown) {
    return this.run(requestId, () => this.me.reportIssue(auth, body, requestId));
  }
}
