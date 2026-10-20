import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UseFilters,
} from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, EsignSenderBoundary } from '@aramo/identity';

import { toHttp } from '../esign-http.controller.js';

import { ESIGN_CREATE_SCOPE, ESIGN_READ_SCOPE, ESIGN_SEND_SCOPE, SenderContextService } from './sender-context.service.js';
import { SenderEnvelopeService, type UploadDocumentBody } from './sender-envelope.service.js';
import { SenderMembersService } from './sender-members.service.js';

// PX-V1 §8 (D-2) — the AUTHENTICATED SENDER surface on sign-service: the third
// E-Sign auth zone, distinct from the internal service-to-service envelopes
// surface (v1/sign/envelopes) and the capability-token signer surface
// (v1/sign/signing). Every route mounts EsignSenderBoundary:
//   JwtAuthGuard → consumer must be `sign` → tenant `sign` capability → scope.
// Reads need sign:envelope:read; draft authoring sign:envelope:create; send,
// remind and void sign:envelope:send; contacts sign:contact:read; member
// administration sign:member:manage. Sign Unified Product S-1: the service then
// applies own-vs-organization visibility (sign:envelope:read:all) and envelope
// ownership (sign:envelope:manage:all) on every read and change. A PERSONAL tenant is refused every write
// in the service (Lead Host & Workspace Ruling v1.0: Personal sending not enabled).
// tenant_id and the acting user come only from the verified auth context.
@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class EsignSenderController {
  constructor(
    private readonly ctx: SenderContextService,
    private readonly envelopes: SenderEnvelopeService,
    private readonly members: SenderMembersService,
  ) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get('context')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  context(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.ctx.context(auth, requestId));
  }

  @Get('summary')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  summary(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.envelopes.summary(auth, requestId));
  }

  @Get('envelopes')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  list(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Query('tab') tab?: string,
    @Query('q') q?: string,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    return this.run(requestId, () =>
      this.envelopes.list(
        auth,
        { ...(tab !== undefined ? { tab } : {}), ...(q !== undefined ? { q } : {}), ...(days !== undefined ? { days } : {}), ...(limit !== undefined ? { limit } : {}) },
        requestId,
      ),
    );
  }

  @Post('envelopes')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  create(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { subject?: unknown }) {
    return this.run(requestId, () => this.envelopes.create(auth, body, requestId));
  }

  @Get('envelopes/:id')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  detail(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.envelopes.detail(auth, id, requestId));
  }

  @Patch('envelopes/:id')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  update(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { subject?: unknown }) {
    return this.run(requestId, () => this.envelopes.update(auth, id, body, requestId));
  }

  @Get('envelopes/:id/events')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  events(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.envelopes.events(auth, id, requestId));
  }

  @Post('envelopes/:id/documents')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  upload(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: UploadDocumentBody) {
    return this.run(requestId, () => this.envelopes.upload(auth, id, body, requestId));
  }

  @Put('envelopes/:id/documents/order')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  reorder(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { order?: unknown }) {
    return this.run(requestId, () => this.envelopes.reorderDocuments(auth, id, body, requestId));
  }

  @Patch('envelopes/:id/documents/:documentId')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  rename(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: { title?: unknown },
  ) {
    return this.run(requestId, () => this.envelopes.renameDocument(auth, id, documentId, body, requestId));
  }

  @Delete('envelopes/:id/documents/:documentId')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  remove(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Param('documentId') documentId: string) {
    return this.run(requestId, () => this.envelopes.removeDocument(auth, id, documentId, requestId));
  }

  @Get('envelopes/:id/documents/:documentId/source')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  async source(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ): Promise<StreamableFile> {
    const bytes = await this.run(requestId, () => this.envelopes.source(auth, id, documentId, requestId));
    return new StreamableFile(Buffer.from(bytes), { type: 'application/pdf', disposition: 'inline' });
  }

  @Put('envelopes/:id/recipients')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  recipients(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { recipients?: unknown }) {
    return this.run(requestId, () => this.envelopes.replaceRecipients(auth, id, body, requestId));
  }

  @Put('envelopes/:id/fields')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  fields(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { fields?: unknown }) {
    return this.run(requestId, () => this.envelopes.replaceFields(auth, id, body, requestId));
  }

  @Post('envelopes/:id/send')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SEND_SCOPE)
  send(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { subject?: unknown }) {
    return this.run(requestId, () => this.envelopes.send(auth, id, body, requestId));
  }

  @Post('envelopes/:id/remind')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SEND_SCOPE)
  remind(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.envelopes.remind(auth, id, requestId));
  }

  @Post('envelopes/:id/void')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SEND_SCOPE)
  void(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return this.run(requestId, () => this.envelopes.void(auth, id, body, requestId));
  }

  @Get('envelopes/:id/executed')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  executed(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.envelopes.executed(auth, id, requestId));
  }

  @Get('envelopes/:id/evidence')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  evidence(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.envelopes.evidence(auth, id, requestId));
  }

  @Get('documents')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  documents(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.envelopes.documents(auth, requestId));
  }

  @Get('contacts')
  @EsignSenderBoundary(ESIGN_SCOPE.CONTACT_READ)
  contacts(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.envelopes.contacts(auth, requestId));
  }

  // Sign Unified Product S-1 — Sign member administration (sign:member:manage).
  @Get('members')
  @EsignSenderBoundary(ESIGN_SCOPE.MEMBER_MANAGE)
  listMembers(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.members.list(auth, requestId));
  }

  @Put('members/:userId/sign-role')
  @EsignSenderBoundary(ESIGN_SCOPE.MEMBER_MANAGE)
  setMemberRole(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('userId') userId: string,
    @Body() body: { sign_role?: unknown },
  ) {
    return this.run(requestId, () => this.members.setRole(auth, userId, body, requestId));
  }

  @Get('activity')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  activity(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Query('limit') limit?: string) {
    return this.run(requestId, () => this.envelopes.activity(auth, requestId, limit));
  }
}
