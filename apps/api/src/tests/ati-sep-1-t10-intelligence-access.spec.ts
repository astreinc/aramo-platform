import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import {
  IntelligenceNotConfiguredError,
  IntelligenceRejectedError,
  IntelligenceUnavailableError,
} from '@aramo/intelligence-integration';

import { DossierService, trustStatements } from '../talent-identity/dossier.service.js';
import { EmailVerificationService } from '../talent-identity/email-verification.service.js';
import { IntelligenceAccess, intelligenceError } from '../talent-identity/intelligence-access.js';

// ATI-SEP-1 T10 WP3b — the fail-soft gate + error mapping every recruiter trust
// surface reads Talent Intelligence through, plus the pure dossier / status
// mapping. (HTTP + Postgres behaviour: ati-sep-1-t10-trust-surfaces.integration.spec.ts.)

const T = '01900000-0000-7000-8000-0000000000a1';
const R = '01900000-0000-7000-8000-00000000a001';

function access(opts: { configured?: boolean; caps?: string[]; capsThrow?: boolean; client?: Record<string, unknown> } = {}) {
  const client = { configured: opts.configured ?? true, ...(opts.client ?? {}) };
  const entitlements = {
    getCapabilities: vi.fn(async () => {
      if (opts.capsThrow) throw new Error('db down');
      return new Set(opts.caps ?? ['intelligence']);
    }),
  };
  return { ti: new IntelligenceAccess(client as never, entitlements as never), client, entitlements };
}

describe('IntelligenceAccess — the local gate', () => {
  it('NOT_CONFIGURED / NOT_ENTITLED / UNAVAILABLE (entitlement read failed) / ENABLED', async () => {
    expect(await access({ configured: false }).ti.gate(T)).toBe('NOT_CONFIGURED');
    expect(await access({ caps: ['ats'] }).ti.gate(T)).toBe('NOT_ENTITLED');
    expect(await access({ capsThrow: true }).ti.gate(T)).toBe('UNAVAILABLE');
    expect(await access().ti.gate(T)).toBe('ENABLED');
  });

  it('read never throws and never calls TI when gated off', async () => {
    const fn = vi.fn();
    expect(await access({ caps: [] }).ti.read(T, fn)).toEqual({ status: 'NOT_ENTITLED', value: null });
    expect(fn).not.toHaveBeenCalled();
    const ok = await access().ti.read(T, async () => 42);
    expect(ok).toEqual({ status: 'ENABLED', value: 42 });
    const cases: Array<[unknown, string]> = [
      [new IntelligenceRejectedError(404, 'REFERENCE_NOT_FOUND', 'x'), 'ENABLED'],
      [new IntelligenceRejectedError(403, 'NOT_ENTITLED', 'x'), 'NOT_ENTITLED'],
      [new IntelligenceRejectedError(400, 'INVALID_REQUEST', 'x'), 'UNAVAILABLE'],
      [new IntelligenceUnavailableError('down', 503), 'UNAVAILABLE'],
      [new IntelligenceNotConfiguredError(), 'NOT_CONFIGURED'],
      [new Error('boom'), 'UNAVAILABLE'],
    ];
    for (const [err, status] of cases) {
      expect(await access().ti.read(T, async () => Promise.reject(err))).toEqual({ status, value: null });
    }
  });

  it('act refuses with INTELLIGENCE_UNAVAILABLE (details.intelligence_status) when gated off', async () => {
    await expect(access({ configured: false }).ti.act(T, 'rq', async () => 1)).rejects.toMatchObject({
      code: 'INTELLIGENCE_UNAVAILABLE',
      statusCode: 503,
      context: { details: { intelligence_status: 'NOT_CONFIGURED' } },
    });
    await expect(access({ caps: [] }).ti.act(T, 'rq', async () => 1)).rejects.toMatchObject({
      context: { details: { intelligence_status: 'NOT_ENTITLED' } },
    });
  });
});

describe('intelligenceError — TI refusal → ATS error (never a 500)', () => {
  const cases: Array<[unknown, string, number]> = [
    [new IntelligenceRejectedError(404, 'NOT_FOUND', 'x'), 'NOT_FOUND', 404],
    [new IntelligenceRejectedError(404, 'VERIFICATION_NOT_FOUND', 'x'), 'NOT_FOUND', 404],
    [new IntelligenceRejectedError(409, 'PROPOSAL_NOT_OPEN', 'x'), 'PROPOSAL_NOT_OPEN', 409],
    [new IntelligenceRejectedError(422, 'ASSERTION_NOT_CONTRADICTED', 'x'), 'EVIDENCE_NOT_CONTRADICTED', 422],
    [new IntelligenceRejectedError(422, 'ASSERTION_NOT_DISPUTABLE', 'x'), 'EVIDENCE_NOT_DISPUTABLE', 422],
    [new IntelligenceRejectedError(422, 'DISPUTE_NOT_UNDER_REVIEW', 'x'), 'PORTAL_DISPUTE_NOT_OPEN', 422],
    [new IntelligenceRejectedError(422, 'DISPUTE_EXTENSION_USED', 'x'), 'PORTAL_DISPUTE_EXTENSION_USED', 422],
    [new IntelligenceRejectedError(403, 'RESOLUTION_NOT_PERMITTED', 'x'), 'INSUFFICIENT_PERMISSIONS', 403],
    [new IntelligenceRejectedError(400, 'INVALID_REQUEST', 'x'), 'VALIDATION_ERROR', 400],
    [new IntelligenceRejectedError(422, 'VERIFICATION_LOCKED', 'x'), 'IDENTIFIER_VERIFICATION_REFUSED', 422],
    [new IntelligenceRejectedError(403, 'NOT_ENTITLED', 'x'), 'INTELLIGENCE_UNAVAILABLE', 503],
    [new IntelligenceRejectedError(403, 'SOURCE_SYSTEM_MISMATCH', 'x'), 'INTELLIGENCE_UNAVAILABLE', 503],
    [new IntelligenceUnavailableError('down'), 'INTELLIGENCE_UNAVAILABLE', 503],
    [new IntelligenceNotConfiguredError(), 'INTELLIGENCE_UNAVAILABLE', 503],
    [new Error('unexpected'), 'INTELLIGENCE_UNAVAILABLE', 503],
  ];
  it.each(cases)('%s → %s %d', (err, code, status) => {
    const e = intelligenceError(err, 'rq');
    expect(e).toBeInstanceOf(AramoError);
    expect(e.code).toBe(code);
    expect(e.statusCode).toBe(status);
  });

  it('INVALID_CODE carries attempts_remaining; a 404 carries no detail (uniform)', () => {
    const e = intelligenceError(new IntelligenceRejectedError(422, 'INVALID_CODE', 'x', { attempts_remaining: 2 }), 'rq');
    expect(e.context.details).toEqual({ reason: 'INVALID_CODE', attempts_remaining: 2 });
    expect(intelligenceError(new IntelligenceRejectedError(404, 'REFERENCE_NOT_FOUND', 'x'), 'rq').context.details).toBeUndefined();
  });
});

describe('dossier presentation', () => {
  it('trust flags → words, never a count', () => {
    const s = trustStatements({
      identity_band: 'NOT_ESTABLISHED',
      claims_band: 'NOT_ESTABLISHED',
      continuity_band: 'NOT_ESTABLISHED',
      eligibility_band: 'NOT_ESTABLISHED',
      open_contradiction_count: 3,
      stale_assertion_count: 2,
      has_open_dispute: true,
      single_source_only: true,
      verification_stale: true,
    });
    expect(s).toHaveLength(5);
    expect(s.join(' ')).not.toMatch(/\d/);
  });

  it('a TI read failure on the evidence leg still serves the head (no contradictions)', async () => {
    const { ti } = access({
      client: {
        readProfile: async () => ({
          intelligence_subject_id: 's',
          access_mode: 'TENANT_SCOPED',
          facts: [],
          generated_at: 'now',
          trust: {
            identity_band: 'CORROBORATED',
            claims_band: 'NOT_ESTABLISHED',
            continuity_band: 'NOT_ESTABLISHED',
            eligibility_band: 'NOT_ESTABLISHED',
            open_contradiction_count: 0,
            stale_assertion_count: 0,
            has_open_dispute: false,
            single_source_only: false,
            verification_stale: false,
          },
        }),
        readEvidence: async () => Promise.reject(new IntelligenceUnavailableError('down')),
      },
    });
    const head = await new DossierService(ti).getDossier(T, R);
    expect(head).toMatchObject({ intelligence_status: 'ENABLED', ledger_established: true, contradictions: [] });
    expect(head.dimensions.identity.band).toBe('CORROBORATED');
  });
});

describe('email verification status — slot matching by TI mask', () => {
  function svc(record: { email1: string | null; email2: string | null }, items: unknown[]) {
    const records = { findById: async () => ({ id: R, record_status: 'live', ...record }) };
    const { ti } = access({ client: { listReferenceVerifications: async () => ({ items }) } });
    return new EmailVerificationService(records as never, {} as never, ti);
  }
  const auth = { tenant_id: T, sub: 'u' } as never;

  it('matches each slot to its masked item; an empty slot is none', async () => {
    const s = svc({ email1: 'Jane@Example.com', email2: null }, [
      { identifier_type: 'EMAIL', value_masked: 'j***@example.com', status: 'VERIFIED', expires_at: 'x' },
    ]);
    expect((await s.getStatus({ recordId: R, authContext: auth, requestId: 'rq' })).items).toEqual([
      { slot: 'email1', value_present: true, status: 'verified', expires_at: 'x' },
      { slot: 'email2', value_present: false, status: 'none', expires_at: null },
    ]);
  });

  it('two different addresses sharing one mask are reported as none (never guessed)', async () => {
    const s = svc({ email1: 'jack@example.com', email2: 'jill@example.com' }, [
      { identifier_type: 'EMAIL', value_masked: 'j***@example.com', status: 'VERIFIED', expires_at: 'x' },
    ]);
    const r = await s.getStatus({ recordId: R, authContext: auth, requestId: 'rq' });
    expect(r.items.map((i) => i.status)).toEqual(['none', 'none']);
  });
});
