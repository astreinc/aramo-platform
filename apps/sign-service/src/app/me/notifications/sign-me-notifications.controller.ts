import { applyDecorators, Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Post, Put, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType, JwtAuthGuard } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { EsignSenderConsumerGuard } from '@aramo/identity';

import { SignMeNotificationsService, type FeedItemView } from './sign-me-notifications.service.js';

// Aramo Sign Mobile — the signed-in user's notifications, push device and push
// preferences (Aramo-Sign-Unified-Product-Amendment-M-A3-Mobile-Owned-Data-
// Contracts-v1_0-LOCKED §1, §2, §9), for web and mobile clients alike:
//
//   GET    /v1/sign/me/notifications?cursor&limit   { items, next_cursor }
//   GET    /v1/sign/me/notifications/unread-count   { count }
//   POST   /v1/sign/me/notifications/{id}/read      204
//   POST   /v1/sign/me/notifications/read-all       204
//   PUT    /v1/sign/me/devices/current              204 (native token only: its dsid)
//   DELETE /v1/sign/me/devices/current              204 (native token only: its dsid)
//   GET    /v1/sign/me/notification-preferences     { signed, viewed, declined, signature_needed, reminders, lock_screen_subject }
//   PUT    /v1/sign/me/notification-preferences     the same body, echoed
//
// The Sign boundary (M-A3 rules): the Aramo JWT → consumer `sign`
// (EsignSenderConsumerGuard) → the tenant's `sign` capability (EntitlementGuard) →
// RolesGuard. Everything is limited to the caller's own (tenant, user).

function MeBoundary(): MethodDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard), RequireCapability('sign'));
}

@Controller('v1/sign/me')
@UseFilters(AramoExceptionFilter)
export class SignMeNotificationsController {
  constructor(private readonly me: SignMeNotificationsService) {}

  @Get('notifications')
  @Header('Cache-Control', 'no-store')
  @MeBoundary()
  list(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: FeedItemView[]; next_cursor: string | null }> {
    return this.me.list(auth, { cursor, limit }, requestId);
  }

  @Get('notifications/unread-count')
  @Header('Cache-Control', 'no-store')
  @MeBoundary()
  unreadCount(@AuthContext() auth: AuthContextType): Promise<{ count: number }> {
    return this.me.unreadCount(auth);
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MeBoundary()
  async markAllRead(@AuthContext() auth: AuthContextType): Promise<void> {
    await this.me.markAllRead(auth);
  }

  @Post('notifications/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MeBoundary()
  async markRead(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string): Promise<void> {
    await this.me.markRead(auth, id, requestId);
  }

  @Put('devices/current')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MeBoundary()
  async registerDevice(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: Record<string, unknown>): Promise<void> {
    await this.me.registerDevice(auth, body, requestId);
  }

  @Delete('devices/current')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MeBoundary()
  async removeDevice(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<void> {
    await this.me.removeDevice(auth, requestId);
  }

  @Get('notification-preferences')
  @Header('Cache-Control', 'no-store')
  @MeBoundary()
  getPreferences(@AuthContext() auth: AuthContextType) {
    return this.me.getPreferences(auth);
  }

  @Put('notification-preferences')
  @HttpCode(HttpStatus.OK)
  @MeBoundary()
  putPreferences(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: Record<string, unknown>) {
    return this.me.putPreferences(auth, body, requestId);
  }
}
