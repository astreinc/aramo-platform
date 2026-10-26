import { describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';
import type { IdentityRepository, TenantRepository } from '@aramo/identity';
import { LEGAL_DOCUMENTS, type LegalAcceptanceService, type LegalDocumentVersion } from '@aramo/subscription';

import { LEGAL_ACCEPTANCE_REQUIRED_REASON, PersonalLegalStatusService, legalAcceptanceRequired } from '../app/legal/personal-legal-status.service.js';

// Aramo Sign Personal (Free) — the Personal documents still to accept, against an
// in-memory acceptance ledger: signup acceptance counts; a newer approved version
// is pending again; only the exact current versions can be accepted; Business is
// never asked.

interface Row {
  tenant_id: string;
  user_id: string;
  document_key: string;
  version: string;
  sha256: string;
  ip: string | null;
}

function harness(registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS, clock?: () => Date) {
  const rows: Row[] = [];
  const kinds = new Map<string, string>([
    ['t-personal', 'PERSONAL'],
    ['t-business', 'BUSINESS'],
  ]);
  const acceptances = {
    async acceptedBy(i: { tenant_id: string; user_id: string; keys: readonly string[] }) {
      return rows.filter((r) => r.tenant_id === i.tenant_id && r.user_id === i.user_id && i.keys.includes(r.document_key));
    },
    async recordInApp(i: { document: LegalDocumentVersion; tenant_id: string; user_id: string; ip: string | null }) {
      if (rows.some((r) => r.tenant_id === i.tenant_id && r.user_id === i.user_id && r.document_key === i.document.key && r.version === i.document.version)) return 'ALREADY';
      rows.push({ tenant_id: i.tenant_id, user_id: i.user_id, document_key: i.document.key, version: i.document.version, sha256: i.document.sha256, ip: i.ip });
      return 'RECORDED';
    },
  } as unknown as LegalAcceptanceService;
  const tenants = { findById: async (id: string) => (kinds.has(id) ? { id, kind: kinds.get(id) } : null) } as unknown as TenantRepository;
  const identity = { findUserById: async () => ({ email: 'pat@gmail.com' }) } as unknown as IdentityRepository;
  return { rows, svc: new PersonalLegalStatusService(acceptances, tenants, identity, registry, clock) };
}

const approved = (key: string) => LEGAL_DOCUMENTS.find((d) => d.key === key && d.status === 'APPROVED')!;
const ALL = ['sign.personal_terms_of_service', 'aramo.privacy_notice', 'aramo.acceptable_use_policy'];

describe('PersonalLegalStatusService', () => {
  it('a Personal user with no acceptance has the three current documents pending, with title and Sign-host URL', async () => {
    const { svc } = harness();
    const p = await svc.pending('t-personal', 'u1');
    expect(p.map((d) => d.key)).toEqual(ALL);
    expect(p[0]).toEqual({ key: 'sign.personal_terms_of_service', version: '1.0', url: 'https://sign.aramo.ai/legal/personal-terms/1.0', title: 'Aramo Sign Personal Terms of Service' });
  });

  it('Business tenants and unknown tenants have nothing pending', async () => {
    const { svc } = harness();
    expect(await svc.pending('t-business', 'u1')).toEqual([]);
    expect(await svc.pending('t-missing', 'u1')).toEqual([]);
  });

  it('acceptance at signup (same version and text) clears the document; another user of the tenant is unaffected', async () => {
    const { svc, rows } = harness();
    for (const k of ALL) rows.push({ tenant_id: 't-personal', user_id: 'u1', document_key: k, version: '1.0', sha256: approved(k).sha256, ip: null });
    expect(await svc.pending('t-personal', 'u1')).toEqual([]);
    expect((await svc.pending('t-personal', 'u2')).length).toBe(3);
  });

  it('a newer APPROVED version is pending again until accepted in the app; the acceptance records the client address', async () => {
    const terms = approved('sign.personal_terms_of_service');
    const v11: LegalDocumentVersion = { ...terms, version: '1.1', sha256: 'f'.repeat(64), url: 'https://sign.aramo.ai/legal/personal-terms/1.1' };
    const { svc, rows } = harness([...LEGAL_DOCUMENTS, v11]);
    for (const k of ALL) rows.push({ tenant_id: 't-personal', user_id: 'u1', document_key: k, version: '1.0', sha256: approved(k).sha256, ip: null });
    expect((await svc.pending('t-personal', 'u1')).map((d) => `${d.key}@${d.version}`)).toEqual(['sign.personal_terms_of_service@1.1']);
    const left = await svc.accept('t-personal', 'u1', [{ key: 'sign.personal_terms_of_service', version: '1.1' }], { ip: '198.51.100.1', user_agent: 'UA' }, 'r');
    expect(left).toEqual([]);
    expect(rows.at(-1)).toMatchObject({ document_key: 'sign.personal_terms_of_service', version: '1.1', ip: '198.51.100.1' });
    // Idempotent.
    await svc.accept('t-personal', 'u1', [{ key: 'sign.personal_terms_of_service', version: '1.1' }], { ip: null, user_agent: null }, 'r');
    expect(rows.filter((r) => r.version === '1.1')).toHaveLength(1);
  });

  it('only the exact current versions can be accepted; a bad item refuses the whole request', async () => {
    const { svc, rows } = harness();
    const reasonOf = async (items: unknown): Promise<unknown> => {
      try {
        await svc.accept('t-personal', 'u1', items, { ip: null, user_agent: null }, 'r');
        return 'accepted';
      } catch (e) {
        expect(e).toBeInstanceOf(AramoError);
        return (e as AramoError).context.details?.['reason'];
      }
    };
    expect(await reasonOf([{ key: 'aramo.privacy_notice', version: '1.0' }, { key: 'sign.personal_terms_of_service', version: '0.9' }])).toBe('legal_version_not_current');
    expect(await reasonOf([{ key: 'sign.terms_of_service', version: '0.1.1' }])).toBe('legal_version_not_current');
    expect(rows).toHaveLength(0);
    for (const bad of [undefined, [], 'x', [{ key: 1, version: '1.0' }], Array.from({ length: 11 }, () => ({ key: 'a', version: '1' }))]) {
      await expect(svc.accept('t-personal', 'u1', bad, { ip: null, user_agent: null }, 'r')).rejects.toBeInstanceOf(AramoError);
    }
    await expect(svc.accept('t-business', 'u1', [{ key: 'aramo.privacy_notice', version: '1.0' }], { ip: null, user_agent: null }, 'r')).rejects.toBeInstanceOf(AramoError);
    expect(rows).toHaveLength(0);
    expect(await svc.accept('t-personal', 'u1', ALL.map((key) => ({ key, version: '1.0' })), { ip: null, user_agent: null }, 'r')).toEqual([]);
    expect(rows).toHaveLength(3);
  });

  it('a key with no APPROVED version is never pending', async () => {
    const { svc } = harness(LEGAL_DOCUMENTS.filter((d) => d.key !== 'aramo.acceptable_use_policy'));
    expect((await svc.pending('t-personal', 'u1')).map((d) => d.key)).toEqual(['sign.personal_terms_of_service', 'aramo.privacy_notice']);
  });

  // Privacy Notice 1.1 Remediation Directive §3 / decision 6 (E-5): an approved
  // UPCOMING version is never owed (nor acceptable) before its effective_from.
  it('E-5: an upcoming version is not pending and cannot be accepted until it takes effect (injected clock)', async () => {
    const privacy = approved('aramo.privacy_notice');
    const v11: LegalDocumentVersion = { ...privacy, version: '1.1', sha256: 'e'.repeat(64), url: 'https://sign.aramo.ai/legal/privacy/1.1', effective_from: '2026-11-25T00:00:00Z' };
    let now = new Date('2026-11-24T23:59:59.999Z');
    const { svc, rows } = harness([...LEGAL_DOCUMENTS, v11], () => now);
    for (const k of ALL) rows.push({ tenant_id: 't-personal', user_id: 'u1', document_key: k, version: '1.0', sha256: approved(k).sha256, ip: null });
    expect(await svc.pending('t-personal', 'u1')).toEqual([]);
    expect(svc.current().find((d) => d.key === 'aramo.privacy_notice')!.version).toBe('1.0');
    await expect(svc.accept('t-personal', 'u1', [{ key: 'aramo.privacy_notice', version: '1.1' }], { ip: null, user_agent: null }, 'r')).rejects.toMatchObject({
      context: { details: { reason: 'legal_version_not_current' } },
    });
    // AT the effective instant, 1.1 is owed; accepting it clears the gate.
    now = new Date('2026-11-25T00:00:00Z');
    expect((await svc.pending('t-personal', 'u1')).map((d) => `${d.key}@${d.version}`)).toEqual(['aramo.privacy_notice@1.1']);
    expect(await svc.accept('t-personal', 'u1', [{ key: 'aramo.privacy_notice', version: '1.1' }], { ip: null, user_agent: null }, 'r')).toEqual([]);
    // 1.0 is no longer acceptable once superseded.
    await expect(svc.accept('t-personal', 'u1', [{ key: 'aramo.privacy_notice', version: '1.0' }], { ip: null, user_agent: null }, 'r')).rejects.toBeInstanceOf(AramoError);
  });

  it('E-5: a new user before the effective date is offered 1.0, not the upcoming 1.1', async () => {
    const privacy = approved('aramo.privacy_notice');
    const v11: LegalDocumentVersion = { ...privacy, version: '1.1', sha256: 'e'.repeat(64), url: 'https://sign.aramo.ai/legal/privacy/1.1', effective_from: '2026-11-25T00:00:00Z' };
    const { svc } = harness([...LEGAL_DOCUMENTS, v11], () => new Date('2026-11-01T00:00:00Z'));
    expect((await svc.pending('t-personal', 'u9')).map((d) => `${d.key}@${d.version}`)).toEqual([
      'sign.personal_terms_of_service@1.0',
      'aramo.privacy_notice@1.0',
      'aramo.acceptable_use_policy@1.0',
    ]);
  });

  it('the send refusal while documents are pending is a 403 with reason legal_acceptance_required', () => {
    const e = legalAcceptanceRequired('r');
    expect(e.statusCode).toBe(403);
    expect(e.context.details?.['reason']).toBe(LEGAL_ACCEPTANCE_REQUIRED_REASON);
  });
});
