import { Body, Controller, Headers, HttpCode, HttpStatus, Injectable, Logger, Post, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { SignIntegrationRepository, SignTalentErasureRepository, type SignTalentErasureScope } from '@aramo/sign';

import { secretMatches } from '../integrations/credentials.js';

// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-3, §4 D-1/D-2 —
// the Sign-owned talent-erasure contract the ATS erasure engine calls instead of
// reading or writing the sign schema.
//
//   POST /v1/sign/s2s/talent-erasure/preflight  { tenant_id, record_ids[], document_refs[] }
//        → { holders[], erasable }  (read-only; any holder blocks the erasure)
//   POST /v1/sign/s2s/talent-erasure/erase      { tenant_id, run_id, record_ids[], document_refs[] }
//        → { status: 'erased', counts } | { status: 'blocked', holders[] } (nothing deleted)
//
// Internal only: nginx routes no /v1/sign/s2s path. The caller authenticates as the
// first-party aramo-ats Sign API client (HTTP Basic, the credential the authenticated
// ATS transport already holds); any other application's credential is refused. No
// token is minted, and the obligation does not depend on the tenant's Sign plan or
// installation. Logs carry counts and the run id only, never a record id.

export const ATS_SIGN_APPLICATION_KEY = 'aramo-ats';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 1000;

interface ErasureBody {
  tenant_id?: unknown;
  run_id?: unknown;
  record_ids?: unknown;
  document_refs?: unknown;
}

function basicCredentials(authorization: string | undefined): { client_id: string; client_secret: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(authorization ?? '');
  if (m === null || m[1] === undefined) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i <= 0) return null;
  return { client_id: decodeURIComponent(decoded.slice(0, i)), client_secret: decodeURIComponent(decoded.slice(i + 1)) };
}

function uuids(v: unknown, field: string, requestId: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_IDS || !v.every((x) => typeof x === 'string' && UUID_RE.test(x))) {
    throw new AramoError('VALIDATION_ERROR', `${field} must be an array of at most ${MAX_IDS} UUIDs`, 400, { requestId });
  }
  return [...new Set(v.map((x) => x.toLowerCase()))];
}

@Injectable()
export class SignTalentErasureService {
  private readonly log = new Logger('SignTalentErasure');

  constructor(
    private readonly integrations: SignIntegrationRepository,
    private readonly repo: SignTalentErasureRepository,
  ) {}

  async authenticate(authorization: string | undefined, requestId: string): Promise<void> {
    const presented = basicCredentials(authorization);
    const denied = () => new AramoError('AUTH_REQUIRED', 'Client authentication failed', 401, { requestId });
    if (presented === null) throw denied();
    const cred = await this.integrations.findCredentialByClientId(presented.client_id);
    if (
      cred === null ||
      cred.status !== 'ACTIVE' ||
      (cred.expires_at !== null && cred.expires_at <= new Date()) ||
      !secretMatches(presented.client_secret, cred.secret_hash) ||
      cred.application.status !== 'ACTIVE'
    ) {
      throw denied();
    }
    if (cred.application.key !== ATS_SIGN_APPLICATION_KEY || cred.application.kind !== 'FIRST_PARTY') {
      this.log.warn(`talent erasure refused app=${cred.application.key} request=${requestId}`);
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'This application may not request talent erasure', 403, { requestId });
    }
  }

  scope(body: ErasureBody, requestId: string): SignTalentErasureScope {
    if (typeof body.tenant_id !== 'string' || !UUID_RE.test(body.tenant_id)) {
      throw new AramoError('VALIDATION_ERROR', 'tenant_id must be a UUID', 400, { requestId });
    }
    return {
      tenant_id: body.tenant_id.toLowerCase(),
      record_ids: uuids(body.record_ids, 'record_ids', requestId),
      document_refs: uuids(body.document_refs ?? [], 'document_refs', requestId),
    };
  }

  async preflight(scope: SignTalentErasureScope, requestId: string) {
    const out = await this.repo.preflight(scope);
    this.log.log(`talent erasure preflight tenant=${scope.tenant_id} records=${scope.record_ids.length} holders=${out.holders.length} request=${requestId}`);
    return out;
  }

  async erase(scope: SignTalentErasureScope, run_id: string, requestId: string) {
    const out = await this.repo.erase(scope);
    if (out.status === 'blocked') {
      this.log.warn(`talent erasure blocked tenant=${scope.tenant_id} run=${run_id} holders=${out.holders.length} request=${requestId}`);
      return { status: 'blocked' as const, run_id, holders: out.holders };
    }
    const c = out.counts;
    this.log.log(
      `talent erasure done tenant=${scope.tenant_id} run=${run_id} idempotency=${c.idempotency_keys} api_idempotency=${c.api_idempotency_keys} outbox=${c.outbox_events} request=${requestId}`,
    );
    return { status: 'erased' as const, run_id, counts: c };
  }
}

@Controller('v1/sign/s2s/talent-erasure')
@UseFilters(AramoExceptionFilter)
export class SignTalentErasureController {
  constructor(private readonly svc: SignTalentErasureService) {}

  @Post('preflight')
  @HttpCode(HttpStatus.OK)
  async preflight(@Body() body: ErasureBody, @Headers('authorization') authorization: string | undefined, @RequestId() requestId: string) {
    await this.svc.authenticate(authorization, requestId);
    return this.svc.preflight(this.svc.scope(body ?? {}, requestId), requestId);
  }

  @Post('erase')
  @HttpCode(HttpStatus.OK)
  async erase(@Body() body: ErasureBody, @Headers('authorization') authorization: string | undefined, @RequestId() requestId: string) {
    await this.svc.authenticate(authorization, requestId);
    const b = body ?? {};
    if (typeof b.run_id !== 'string' || !UUID_RE.test(b.run_id)) {
      throw new AramoError('VALIDATION_ERROR', 'run_id must be a UUID', 400, { requestId });
    }
    return this.svc.erase(this.svc.scope(b, requestId), b.run_id, requestId);
  }
}
