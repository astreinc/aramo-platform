import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { SIGN_TEMPLATE_BODY_DIGEST_PARAM, signTemplateBodyDigest } from '@aramo/documents-contracts';

import { EsignServiceRequestGuard } from '../integrations/sign/esign-service-request.guard.js';

import { SignTemplateLibraryService } from './sign-template-library.service.js';

// DOC-TEMPLATE-LIB-1 T-5 — Implementation Directive v1.0 (LOCKED) §7.1 (ADR-0034 D12;
// Conforming Amendment #9). The Documents template-library endpoints for Aramo Sign, in
// the SAME family as DocumentsEsignController: every route is callable ONLY by
// sign-service (EsignServiceRequestGuard, scheme aramo-sign-s2s-v1). The request carries
// no user and no scope — sign-service checks the caller's session (document_template:read,
// and sign:envelope:create for an envelope) BEFORE it calls. tenant_id is the
// caller-supplied scope, bound by the signature, and every read/write below is
// tenant-scoped (own tenant ∪ the Aramo defaults).
//
//   GET  v1/documents/esign/templates?tenant_id=[&client_id=]
//   POST v1/documents/esign/templates/:id/preview?tenant_id=&body_sha256=
//   POST v1/documents/esign/templates/:id/render?tenant_id=&idempotency_key=&body_sha256=
//
// A POST body is bound by `body_sha256` (signed query) — see sign-template-library.contract.
// render is the first Sign-initiated Documents WRITE; apps/api performs it (DOC-4 R-4-2:
// sign-service MUST NOT write the documents schema).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

function bad(message: string, requestId: string, details?: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, ...(details !== undefined ? { details } : {}) });
}

function requireTenant(tenantId: unknown, requestId: string): string {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw bad('tenant_id is required', requestId);
  return tenantId;
}

function optionalUuid(v: unknown, field: string, requestId: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad(`${field} must be a uuid`, requestId, { field });
  return v;
}

// The received body must hash to the signed body_sha256.
function assertBodyDigest(body: unknown, digest: unknown, requestId: string): void {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw bad(`${SIGN_TEMPLATE_BODY_DIGEST_PARAM} is required`, requestId, { field: SIGN_TEMPLATE_BODY_DIGEST_PARAM });
  }
  if (signTemplateBodyDigest(body ?? {}) !== digest) {
    throw new AramoError('AUTH_REQUIRED', 'sign-service request body does not match its signed digest', 401, { requestId });
  }
}

function values(raw: unknown, requestId: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('values must be an object of text values', requestId, { field: 'values' });
  return raw as Record<string, string>;
}

interface PreviewBody {
  values?: unknown;
}

interface RenderBody {
  values?: unknown;
  created_by?: unknown;
  client_id?: unknown;
}

@Controller('v1/documents/esign/templates')
@UseGuards(EsignServiceRequestGuard)
export class DocumentsEsignTemplatesController {
  constructor(private readonly library: SignTemplateLibraryService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query('tenant_id') tenantId: string, @Query('client_id') clientId: string | undefined, @RequestId() requestId: string) {
    return this.library.list({
      tenant_id: requireTenant(tenantId, requestId),
      client_id: optionalUuid(clientId, 'client_id', requestId),
      requestId,
    });
  }

  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: PreviewBody,
    @RequestId() requestId: string,
  ) {
    const tenant_id = requireTenant(tenantId, requestId);
    assertBodyDigest(body, digest, requestId);
    return this.library.preview({ tenant_id, template_id: id, values: values(body?.values, requestId), requestId });
  }

  @Post(':id/render')
  @HttpCode(HttpStatus.CREATED)
  async render(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Query('idempotency_key') idempotencyKey: string,
    @Query(SIGN_TEMPLATE_BODY_DIGEST_PARAM) digest: string,
    @Body() body: RenderBody,
    @RequestId() requestId: string,
  ) {
    const tenant_id = requireTenant(tenantId, requestId);
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw bad('idempotency_key is required (8-128 of A-Z a-z 0-9 _ -)', requestId, { field: 'idempotency_key' });
    }
    assertBodyDigest(body, digest, requestId);
    const created_by = body?.created_by;
    if (typeof created_by !== 'string' || !UUID_RE.test(created_by)) throw bad('created_by must be a uuid', requestId, { field: 'created_by' });
    return this.library.render({
      tenant_id,
      template_id: id,
      values: values(body?.values, requestId),
      created_by,
      client_id: optionalUuid(body?.client_id, 'client_id', requestId),
      idempotency_key: idempotencyKey,
      requestId,
    });
  }
}
