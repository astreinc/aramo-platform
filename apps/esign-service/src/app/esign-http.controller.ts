import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { EsignService } from '@aramo/esign';
import {
  DisclosureNotAcceptedError,
  EnvelopeIllegalTransitionError,
  EnvelopeNotFoundError,
  SignatureFieldIncompleteError,
  SignerNotFoundError,
  SigningSessionExpiredError,
  SigningSessionInvalidError,
} from '@aramo/esign';
import { type CreateEnvelopeRequest } from '@aramo/documents-contracts';

import { NativeAramoSignatureProvider } from './native-aramo-signature.provider.js';

// DOC-3 — the E-Sign HTTP API. The /envelopes surface is the provider seam that
// apps/api's SignatureProviderPort adapter calls (trusted service-to-service:
// authoritative tenant_id is passed by the caller). The /signing surface is the
// public signer transport (tenant resolved FROM the capability token, never the
// client). TRANSPORT ONLY — no RTR/Submittal/Offer/recruiter-workflow logic.

function toHttp(e: unknown, requestId: string): AramoError {
  if (e instanceof EnvelopeNotFoundError) return new AramoError('ENVELOPE_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof EnvelopeIllegalTransitionError) return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', e.message, 409, { requestId });
  if (e instanceof SignerNotFoundError) return new AramoError('SIGNER_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof SigningSessionExpiredError) return new AramoError('SIGNING_SESSION_EXPIRED', e.message, 401, { requestId });
  if (e instanceof SigningSessionInvalidError) return new AramoError('SIGNING_SESSION_INVALID', e.message, 401, { requestId });
  if (e instanceof DisclosureNotAcceptedError) return new AramoError('DISCLOSURE_NOT_ACCEPTED', e.message, 409, { requestId });
  if (e instanceof SignatureFieldIncompleteError) return new AramoError('SIGNATURE_FIELD_INCOMPLETE', e.message, 409, { requestId });
  return e instanceof AramoError ? e : new AramoError('INTERNAL_ERROR', e instanceof Error ? e.message : String(e), 500, { requestId });
}

function validate(cond: boolean, message: string, requestId: string): void {
  if (!cond) throw new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

@Controller('v1/esign/envelopes')
export class EsignProviderController {
  constructor(private readonly provider: NativeAramoSignatureProvider) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateEnvelopeRequest, @RequestId() requestId: string) {
    validate(typeof body?.tenant_id === 'string', 'tenant_id is required', requestId);
    validate(typeof body?.subject === 'string' && body.subject.length > 0, 'subject is required', requestId);
    validate(Array.isArray(body?.documents) && body.documents.length > 0, 'at least one document is required', requestId);
    validate(Array.isArray(body?.signers) && body.signers.length > 0, 'at least one signer is required', requestId);
    try {
      return await this.provider.createEnvelope(body);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  async send(@Param('id') id: string, @Body() body: { tenant_id: string }, @RequestId() requestId: string) {
    validate(typeof body?.tenant_id === 'string', 'tenant_id is required', requestId);
    try {
      return await this.provider.sendEnvelope(body.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async get(@Param('id') id: string, @Query('tenant_id') tenantId: string, @RequestId() requestId: string) {
    validate(typeof tenantId === 'string', 'tenant_id is required', requestId);
    try {
      return await this.provider.getEnvelope(tenantId, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  async void(@Param('id') id: string, @Body() body: { tenant_id: string; reason: string }, @RequestId() requestId: string) {
    validate(typeof body?.tenant_id === 'string', 'tenant_id is required', requestId);
    validate(typeof body?.reason === 'string' && body.reason.length > 0, 'reason is required', requestId);
    try {
      return await this.provider.voidEnvelope(body.tenant_id, id, body.reason);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get(':id/evidence')
  @HttpCode(HttpStatus.OK)
  async evidence(@Param('id') id: string, @Query('tenant_id') tenantId: string, @RequestId() requestId: string) {
    validate(typeof tenantId === 'string', 'tenant_id is required', requestId);
    try {
      return await this.provider.getEvidence(tenantId, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}

@Controller('v1/esign/signing')
export class EsignSignerController {
  constructor(private readonly service: EsignService) {}

  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  async exchange(@Body() body: { token: string }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string' && body.token.length > 0, 'token is required', requestId);
    try {
      const ctx = await this.service.exchangeToken(body.token);
      return { session_id: ctx.session_id, envelope_id: ctx.envelope_id, signer_id: ctx.signer_id };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('disclosure')
  @HttpCode(HttpStatus.OK)
  async disclosure(
    @Body() body: { token: string; disclosure_version: string; disclosure_text_hash: string },
    @Req() req: Request,
    @RequestId() requestId: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    validate(typeof body?.token === 'string', 'token is required', requestId);
    validate(typeof body?.disclosure_version === 'string', 'disclosure_version is required', requestId);
    validate(typeof body?.disclosure_text_hash === 'string', 'disclosure_text_hash is required', requestId);
    try {
      const ctx = await this.service.resolveSession(body.token);
      await this.service.acceptDisclosure(ctx, {
        disclosure_version: body.disclosure_version,
        disclosure_text_hash: body.disclosure_text_hash,
        ip_address: req.ip,
        user_agent: userAgent,
      });
      return { accepted: true };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('fields/:fieldId/fill')
  @HttpCode(HttpStatus.OK)
  async fill(
    @Param('fieldId') fieldId: string,
    @Body() body: { token: string; value: string; signature_method?: string },
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.token === 'string', 'token is required', requestId);
    validate(typeof body?.value === 'string', 'value is required', requestId);
    try {
      const ctx = await this.service.resolveSession(body.token);
      await this.service.fillField(ctx, fieldId, { value: body.value, signature_method: body.signature_method });
      return { filled: true };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Body() body: { token: string }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string', 'token is required', requestId);
    try {
      const ctx = await this.service.resolveSession(body.token);
      return await this.service.completeSigner(ctx);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('decline')
  @HttpCode(HttpStatus.OK)
  async decline(@Body() body: { token: string; reason: string }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string', 'token is required', requestId);
    validate(typeof body?.reason === 'string' && body.reason.length > 0, 'reason is required', requestId);
    try {
      const ctx = await this.service.resolveSession(body.token);
      await this.service.decline(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, body.reason);
      return { declined: true };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}
