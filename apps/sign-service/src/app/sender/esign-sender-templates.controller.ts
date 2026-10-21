import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { EsignSenderBoundary } from '@aramo/identity';

import { toHttp } from '../esign-http.controller.js';

import { DOCUMENT_TEMPLATE_READ_SCOPE, ESIGN_CREATE_SCOPE } from './sender-context.service.js';
import { SenderTemplatesService, type FromTemplateBody } from './sender-templates.service.js';

// DOC-TEMPLATE-LIB-1 T-5 — the sender's template routes (Implementation Directive v1.0
// LOCKED §7.2–7.4). Same authenticated SENDER zone as EsignSenderController
// (EsignSenderBoundary: JwtAuthGuard → `sign` consumer → `sign` capability → scope):
//
//   GET  v1/sign/sender/templates                   document_template:read
//   POST v1/sign/sender/templates/:id/preview       document_template:read
//   POST v1/sign/sender/envelopes/from-template     sign:envelope:create (+ document_template:read,
//                                                   checked in the service)
//
// Every route is refused while the `sign.templates` plan capability is not available
// (ESIGN_FEATURE_NOT_AVAILABLE, 403). tenant_id and the acting user come only from the
// verified auth context.
@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class EsignSenderTemplatesController {
  constructor(private readonly templates: SenderTemplatesService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get('templates')
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    return this.run(requestId, () => this.templates.list(auth, requestId));
  }

  @Post('templates/:id/preview')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(DOCUMENT_TEMPLATE_READ_SCOPE)
  preview(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { values?: unknown }) {
    return this.run(requestId, () => this.templates.preview(auth, id, body ?? {}, requestId));
  }

  @Post('envelopes/from-template')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  fromTemplate(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: FromTemplateBody) {
    return this.run(requestId, () => this.templates.createEnvelope(auth, body ?? {}, requestId));
  }
}
