import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UseFilters,
} from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, EsignSenderBoundary } from '@aramo/identity';
import type { Request, Response } from 'express';

import { clientIp } from '../personal/personal-send.gate.js';

import { envelopeEtag, idempotencyKey, senderHttp } from './envelope-contracts.js';
import { ESIGN_CREATE_SCOPE, ESIGN_READ_SCOPE, ESIGN_SEND_SCOPE, SenderContextService } from './sender-context.service.js';
import { SenderEnvelopeService, type UploadDocumentBody } from './sender-envelope.service.js';

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
// in the service (Lead Host & Workspace Ruling v1.0: Personal sending not enabled) — lifted only per
// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED (mode not off, bound tenant, sending gate).
// tenant_id and the acting user come only from the verified auth context.
@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class EsignSenderController {
  constructor(
    private readonly ctx: SenderContextService,
    private readonly envelopes: SenderEnvelopeService,
  ) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw senderHttp(e, requestId);
    }
  }

  // Sign Mobile M-A3 §6 — every response that carries the envelope detail carries
  // its strong validator, ETag "{id}.{revision}", for the next If-Match.
  private async withEtag<T extends { id: string; revision: number }>(res: Response, requestId: string, fn: () => Promise<T>): Promise<T> {
    const d = await this.run(requestId, fn);
    res.setHeader('ETag', envelopeEtag(d.id, d.revision));
    return d;
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
  detail(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.withEtag(res, requestId, () => this.envelopes.detail(auth, id, requestId));
  }

  // Sign Mobile M-A3 §3/§6 — also sets the sender message; If-Match is required for
  // native tokens on every draft write, send and void (428 / 412).
  @Patch('envelopes/:id')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  update(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { subject?: unknown; routing_mode?: unknown; message?: unknown },
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.withEtag(res, requestId, () => this.envelopes.update(auth, id, body, requestId, ifMatch));
  }

  // Sign Mobile D-W6-3 — delete a DRAFT (409 envelope_not_draft otherwise). The same
  // authority and If-Match rule as every draft write; 204 with no body.
  @Delete('envelopes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  deleteDraft(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Headers('if-match') ifMatch?: string) {
    return this.run(requestId, () => this.envelopes.deleteDraft(auth, id, requestId, ifMatch));
  }

  @Get('envelopes/:id/events')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  events(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.envelopes.events(auth, id, requestId));
  }

  @Post('envelopes/:id/documents')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  upload(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: UploadDocumentBody,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    // Sign Mobile D-W6-1 — the upload answers with the envelope's new revision and
    // its ETag, so the client chains the next If-Match without re-reading.
    return this.run(requestId, async () => {
      const key = idempotencyKey(idemKey, requestId);
      const out = await this.envelopes.upload(auth, id, body, requestId, { ...(ifMatch !== undefined ? { ifMatch } : {}), ...(key !== undefined ? { idempotencyKey: key } : {}) });
      if (typeof out.revision === 'number') res.setHeader('ETag', envelopeEtag(id, out.revision));
      return out;
    });
  }

  @Put('envelopes/:id/documents/order')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  reorder(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { order?: unknown },
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.withEtag(res, requestId, () => this.envelopes.reorderDocuments(auth, id, body, requestId, ifMatch));
  }

  @Patch('envelopes/:id/documents/:documentId')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  rename(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: { title?: unknown },
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.withEtag(res, requestId, () => this.envelopes.renameDocument(auth, id, documentId, body, requestId, ifMatch));
  }

  @Delete('envelopes/:id/documents/:documentId')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  remove(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.withEtag(res, requestId, () => this.envelopes.removeDocument(auth, id, documentId, requestId, ifMatch));
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
  recipients(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { recipients?: unknown },
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.withEtag(res, requestId, () => this.envelopes.replaceRecipients(auth, id, body, requestId, ifMatch));
  }

  @Put('envelopes/:id/fields')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  fields(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { fields?: unknown },
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.withEtag(res, requestId, () => this.envelopes.replaceFields(auth, id, body, requestId, ifMatch));
  }

  @Post('envelopes/:id/send')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SEND_SCOPE)
  send(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { subject?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.withEtag(res, requestId, () => this.envelopes.send(auth, id, body, requestId, { ip: clientIp(req), ...(ifMatch !== undefined ? { ifMatch } : {}) }));
  }

  // Sign Mobile M-A3 §7 — 429 reminder_cooldown / reminder_daily_limit (retry_after);
  // Idempotency-Key replays return the first response and never count again.
  @Post('envelopes/:id/remind')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SEND_SCOPE)
  remind(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { signer_id?: unknown } = {},
    @Headers('idempotency-key') idemKey?: string,
  ) {
    return this.withEtag(res, requestId, async () => {
      const key = idempotencyKey(idemKey, requestId);
      return this.envelopes.remind(auth, id, body ?? {}, requestId, { ip: clientIp(req), ...(key !== undefined ? { idempotencyKey: key } : {}) });
    });
  }

  // Aramo-Sign-Unified-Product-Amendment-M-A5 §3.2 — start a hosted (in-person)
  // signing session for an IN_PERSON_SIGNER whose turn it is (feature
  // sign.in_person_signing). The raw token is returned only to this authenticated
  // caller; it is never emailed or logged.
  @Post('envelopes/:id/hosted-sessions')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_SEND_SCOPE)
  hostedSession(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { signer_id?: unknown }) {
    return this.run(requestId, () => this.envelopes.hostedSession(auth, id, body ?? {}, requestId));
  }

  // M-A5 §4.2 — a self-sign session for the recipient bound to the caller (Assign to me).
  @Post('envelopes/:id/self-sign-session')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_SEND_SCOPE)
  selfSignSession(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { signer_id?: unknown } = {}) {
    return this.run(requestId, () => this.envelopes.selfSignSession(auth, id, body ?? {}, requestId));
  }

  @Post('envelopes/:id/void')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SEND_SCOPE)
  void(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { reason?: unknown },
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.withEtag(res, requestId, () => this.envelopes.void(auth, id, body, requestId, ifMatch));
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

  // Sign Mobile M-A3 §5 — the caller's private contacts (owner-isolated). Writes
  // need sign:envelope:create (the people who address envelopes keep the address book).
  @Post('contacts')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  createContact(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: Record<string, unknown>) {
    return this.run(requestId, () => this.envelopes.createContact(auth, body, requestId));
  }

  @Patch('contacts/:contactId')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  updateContact(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('contactId') contactId: string, @Body() body: Record<string, unknown>) {
    return this.run(requestId, () => this.envelopes.updateContact(auth, contactId, body, requestId));
  }

  @Delete('contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  deleteContact(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('contactId') contactId: string) {
    return this.run(requestId, () => this.envelopes.deleteContact(auth, contactId, requestId));
  }

  @Get('activity')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  activity(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Query('limit') limit?: string) {
    return this.run(requestId, () => this.envelopes.activity(auth, requestId, limit));
  }
}
