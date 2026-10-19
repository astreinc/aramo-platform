import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Logger, Optional, Param, Post, Query, Req, UseFilters } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import {
  currentDisclosure,
  DOCUMENT_SOURCE_PROVIDER_PORT,
  type DocumentSourceProviderPort,
  ENVELOPE_NOTIFICATION_SERVICE,
  type EnvelopeNotificationService,
  EsignRepository,
  EsignService,
} from '@aramo/esign';
import {
  DisclosureNotAcceptedError,
  DisclosureVersionInvalidError,
  EnvelopeAlreadyExecutedError,
  EnvelopeAmbiguousError,
  EnvelopeIllegalTransitionError,
  EnvelopeNotFoundError,
  ReminderNotAllowedError,
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
//
// IC-3 PR-8 / PX-V1 §11 — THREE auth zones, never merged:
//   1. v1/esign/envelopes  — internal service-to-service (this file; no JWT; the
//      caller is the trusted ATS adapter and passes the authoritative tenant_id).
//   2. v1/esign/sender/*   — the AUTHENTICATED SENDER surface (PX-V1 §8 D-2):
//      ABSENT at the PR-8 baseline. When built it MUST mount
//      `@EsignSenderBoundary()` from @aramo/identity (shared-identity JWT →
//      esign consumer → tenant `esign` capability → effective
//      `esign:envelope:send`); activation also needs apps/esign-web, the
//      esign.aramo.ai ingress and the esign-service → auth/entitlement/
//      authorization wiring (3-place per CLAUDE.md). PR-8 adds NO sender route
//      here on purpose (no dark, unauthenticated send API).
//   3. v1/esign/signing    — capability-token signer transport (below).

export function toHttp(e: unknown, requestId: string): AramoError {
  if (e instanceof EnvelopeNotFoundError) return new AramoError('ENVELOPE_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof EnvelopeIllegalTransitionError) return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', e.message, 409, { requestId });
  // ES-1 — any signer action on a terminal (COMPLETED|DECLINED|VOIDED|EXPIRED) envelope.
  if (e instanceof EnvelopeAlreadyExecutedError) return new AramoError('ENVELOPE_ALREADY_EXECUTED', e.message, 409, { requestId });
  if (e instanceof SignerNotFoundError) return new AramoError('SIGNER_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof SigningSessionExpiredError) return new AramoError('SIGNING_SESSION_EXPIRED', e.message, 401, { requestId });
  if (e instanceof SigningSessionInvalidError) return new AramoError('SIGNING_SESSION_INVALID', e.message, 401, { requestId });
  if (e instanceof DisclosureNotAcceptedError) return new AramoError('DISCLOSURE_NOT_ACCEPTED', e.message, 409, { requestId });
  if (e instanceof SignatureFieldIncompleteError) return new AramoError('SIGNATURE_FIELD_INCOMPLETE', e.message, 409, { requestId });
  if (e instanceof EnvelopeAmbiguousError) return new AramoError('ESIGN_ENVELOPE_AMBIGUOUS', e.message, 409, { requestId });
  if (e instanceof ReminderNotAllowedError) return new AramoError('ESIGN_REMINDER_NOT_ALLOWED', e.message, 409, { requestId });
  // Aramo Sign launch (A-7) — unknown disclosure version or mismatching text hash.
  if (e instanceof DisclosureVersionInvalidError) return new AramoError('VALIDATION_ERROR', e.message, 400, { requestId });
  return e instanceof AramoError ? e : new AramoError('INTERNAL_ERROR', e instanceof Error ? e.message : String(e), 500, { requestId });
}

function validate(cond: boolean, message: string, requestId: string): void {
  if (!cond) throw new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

// The canonical error envelope ({ error: { code, message, details } }) so the ATS
// adapter receives typed refusals (e.g. the Aramo Sign allowance) rather than a
// bare 500.
@UseFilters(AramoExceptionFilter)
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

  // COMM-RECRUITER-W1 (W1-C1) — reverse envelope lookup. Declared BEFORE `:id` so
  // the literal path is not shadowed by the param route. Returns { envelope } with
  // the single non-terminal envelope or null; ESIGN_ENVELOPE_AMBIGUOUS when >1.
  @Get('for-document')
  @HttpCode(HttpStatus.OK)
  async forDocument(
    @Query('tenant_id') tenantId: string,
    @Query('document_ref') documentRef: string,
    @Query('document_revision_ref') revisionRef: string,
    @RequestId() requestId: string,
  ) {
    validate(typeof tenantId === 'string', 'tenant_id is required', requestId);
    validate(typeof documentRef === 'string', 'document_ref is required', requestId);
    validate(typeof revisionRef === 'string', 'document_revision_ref is required', requestId);
    try {
      const envelope = await this.provider.findEnvelopeForDocument(tenantId, documentRef, revisionRef);
      return { envelope };
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

  // COMM-RECRUITER-W1 (W1-C2) — same-envelope reminder (NOT a resend/new envelope).
  @Post(':id/remind')
  @HttpCode(HttpStatus.OK)
  async remind(@Param('id') id: string, @Body() body: { tenant_id: string }, @RequestId() requestId: string) {
    validate(typeof body?.tenant_id === 'string', 'tenant_id is required', requestId);
    try {
      return await this.provider.remindEnvelopeSigner(body.tenant_id, id);
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

  // DOC-4 (R-4-7) — executed-artifact pull for the Documents write-back (bytes
  // as base64; the bus carries only refs).
  @Get(':id/executed')
  @HttpCode(HttpStatus.OK)
  async executed(@Param('id') id: string, @Query('tenant_id') tenantId: string, @RequestId() requestId: string) {
    validate(typeof tenantId === 'string', 'tenant_id is required', requestId);
    try {
      return await this.provider.getExecutedArtifacts(tenantId, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}

// The signer page (sign-web) maps failures by error CODE (SIGNING_SESSION_INVALID,
// SIGNING_SESSION_EXPIRED, ENVELOPE_ALREADY_EXECUTED, …) to its dedicated end
// states; the canonical envelope {error:{code,message,request_id}} carries it.
// Without this filter Nest emitted {statusCode,message} and every bad or expired
// link fell to the generic "Something went wrong" screen.
@Controller('v1/esign/signing')
@UseFilters(AramoExceptionFilter)
export class EsignSignerController {
  private readonly logger = new Logger('EsignSignerController');

  constructor(
    private readonly service: EsignService,
    private readonly repo: EsignRepository,
    @Inject(DOCUMENT_SOURCE_PROVIDER_PORT) private readonly sourceProvider: DocumentSourceProviderPort,
    @Optional() @Inject(ENVELOPE_NOTIFICATION_SERVICE) private readonly notifications?: EnvelopeNotificationService,
  ) {}

  // Aramo Sign launch (A-7) — the CURRENT server-held disclosure the signer must
  // accept: version, exact text and its sha256. Token-authorized like every signer
  // route; the signer app sends version + hash back on acceptance.
  @Post('disclosure-text')
  @HttpCode(HttpStatus.OK)
  async disclosureText(@Body() body: { token: string }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string' && body.token.length > 0, 'token is required', requestId);
    try {
      await this.service.resolveSession(body.token);
      const d = currentDisclosure();
      return { disclosure_version: d.version, text: d.text, text_sha256: d.text_sha256 };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // Aramo Sign launch — the signer's signed copy. Authorized by the time-limited
  // access token from the completion email (not a signing session): returns the
  // executed document(s) and the certificate of completion of a COMPLETED
  // envelope. Tenant resolved server-side from the grant.
  @Post('executed')
  @HttpCode(HttpStatus.OK)
  async executed(@Body() body: { token: string }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string' && body.token.length > 0, 'token is required', requestId);
    try {
      const grant = await this.service.resolveExecutedAccess(body.token);
      const full = await this.repo.getEnvelopeFull(grant.tenant_id, grant.envelope_id);
      const titles = new Map(full.documents.map((d) => [d.id, d.title]));
      const docs = await this.repo.listExecutedDocuments(grant.tenant_id, grant.envelope_id);
      const cert = await this.repo.getExecutionCertificate(grant.tenant_id, grant.envelope_id);
      return {
        subject: full.subject,
        completed_at: full.completed_at ? full.completed_at.toISOString() : null,
        documents: docs.map((d) => ({
          title: titles.get(d.envelope_document_id) ?? 'Signed document',
          content_type: 'application/pdf',
          executed_base64: Buffer.from(d.executed_bytes).toString('base64'),
        })),
        certificate_base64: cert === null ? null : Buffer.from(cert.certificate_bytes).toString('base64'),
      };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // PX-V1 F3 — the signer document VIEW: positioned fields + document metadata for
  // the Sign Web viewer. Token-authorized (tenant resolved server-side),
  // disclosure-gated. Returns NO tenant_id and NO source bytes.
  @Post('document')
  @HttpCode(HttpStatus.OK)
  async document(@Body() body: { token: string }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string' && body.token.length > 0, 'token is required', requestId);
    try {
      const ctx = await this.service.resolveSession(body.token);
      return await this.service.getSignerDocumentView(ctx);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // PX-V1 F3 — the frozen SOURCE PDF bytes for a document in the session, resolved
  // mode-agnostically (OWNED → E-Sign storage, CORE_REF → Documents pull). Bytes
  // are delivered ONLY inside a valid, disclosure-gated session. tenant_id stays
  // server-side (in the descriptor); the response carries only bytes + type.
  @Post('source')
  @HttpCode(HttpStatus.OK)
  async source(@Body() body: { token: string; document_id: string }, @RequestId() requestId: string) {
    validate(typeof body?.token === 'string' && body.token.length > 0, 'token is required', requestId);
    validate(typeof body?.document_id === 'string' && body.document_id.length > 0, 'document_id is required', requestId);
    try {
      const ctx = await this.service.resolveSession(body.token);
      const descriptor = await this.service.resolveSignerSource(ctx, body.document_id);
      const bytes = await this.sourceProvider.getSourcePdf(descriptor);
      return { source_base64: Buffer.from(bytes).toString('base64'), content_type: descriptor.content_type };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

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
      await this.service.decline(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, body.reason, ctx.session_id);
      // Aramo Sign launch — the console sender gets the reason; other open signers
      // learn the envelope ended. Best-effort: the decline itself is already final.
      try {
        await this.notifications?.envelopeDeclined(ctx.tenant_id, ctx.envelope_id, ctx.signer_id, body.reason);
      } catch (err) {
        this.logger.warn(`decline notification failed — envelope ${ctx.envelope_id}: ${(err as Error).message}`);
      }
      return { declined: true };
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}
