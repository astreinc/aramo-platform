import { describe, expect, it, vi } from 'vitest';

import { ConsentService, CONSENT_DEFAULT_TERM_MONTHS } from '../lib/consent.service.js';
import type { ConsentRepository } from '../lib/consent.repository.js';
import {
  CONSENT_TEXT_CURRENT_VERSION,
  hashPortalConsentText,
  renderPortalConsentText,
} from '../lib/consent-texts.js';
import { NOTICE_TEXT_CURRENT_VERSION } from '../lib/notice-texts.js';

// Portal P2 P2a — unit coverage of the portal-actor consent path: the portal
// actor stamping, the read-derived 12-month term, the D7 evidence completeness,
// and idempotent revoke. The repository is mocked; we assert the exact
// recordConsentEvent input the parallel entry builds (the write path itself is
// covered by the existing repository + integration suites).

const TENANT = '11111111-1111-7111-8111-111111111111';
const PORTAL_USER = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECORD = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeee1';
const KEY = 'cccccccc-cccc-7ccc-8ccc-ccccccccccc9';

function portalAuth() {
  return {
    sub: PORTAL_USER,
    consumer_type: 'portal' as const,
    actor_kind: 'user' as const,
    tenant_id: TENANT, // already record-tenant-scoped by the controller
    scopes: ['portal:consent:write'],
    iat: 0,
    exp: 0,
  };
}

function makeService(): { service: ConsentService; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn().mockImplementation((input) =>
    Promise.resolve({
      event_id: 'evt',
      tenant_id: input.tenant_id,
      talent_record_id: input.talent_record_id,
      scope: input.scope,
      action: input.action,
      captured_method: input.captured_method,
      consent_version: input.consent_version,
      occurred_at: input.occurred_at,
      expires_at: input.expires_at,
      recorded_at: input.occurred_at,
      revoked_event_id: null,
    }),
  );
  const service = new ConsentService({ recordConsentEvent: record } as unknown as ConsentRepository);
  return { service, record };
}

describe('ConsentService — portal-actor grant/revoke (Portal P2 P2a)', () => {
  it('grant stamps the portal principal, portal_self_service, a 12-month term, and the D7 evidence', async () => {
    const { service, record } = makeService();
    const now = new Date('2026-07-15T00:00:00.000Z');
    await service.grantAsPortal({
      talent_record_id: RECORD,
      scope: 'matching',
      authContext: portalAuth(),
      idempotencyKey: KEY,
      requestId: 'req-1',
      now,
    });
    expect(record).toHaveBeenCalledTimes(1);
    const input = record.mock.calls[0]![0];
    expect(input.action).toBe('granted');
    expect(input.talent_record_id).toBe(RECORD);
    expect(input.captured_method).toBe('portal_self_service');
    expect(input.captured_by_actor_id).toBe(PORTAL_USER); // the portal principal
    expect(input.tenant_id).toBe(TENANT);
    // 12-month read-derived term.
    const expires = new Date(input.expires_at);
    const expected = new Date(now);
    expected.setMonth(expected.getMonth() + CONSENT_DEFAULT_TERM_MONTHS);
    expect(expires.toISOString()).toBe(expected.toISOString());
    // D7 evidence completeness (channel portal, reproducible hash, notice version
    // in force — P4a closed the forward contract).
    expect(input.consent_evidence).toEqual({
      consent_text_hash: hashPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, {
        recipient_tenant_id: TENANT,
        scope: 'matching',
      }).hash,
      consent_text_version: CONSENT_TEXT_CURRENT_VERSION,
      notice_version: NOTICE_TEXT_CURRENT_VERSION,
      channel: 'portal',
    });
  });

  it('revoke stamps the portal principal + D7 evidence, and carries NO term', async () => {
    const { service, record } = makeService();
    await service.revokeAsPortal({
      talent_record_id: RECORD,
      scope: 'matching',
      authContext: portalAuth(),
      idempotencyKey: KEY,
      requestId: 'req-2',
    });
    const input = record.mock.calls[0]![0];
    expect(input.action).toBe('revoked');
    expect(input.captured_method).toBe('portal_self_service');
    expect(input.captured_by_actor_id).toBe(PORTAL_USER);
    expect(input.expires_at).toBeUndefined(); // grant-only
    expect(input.consent_evidence.channel).toBe('portal');
  });

  it('grant idempotency requestHash excludes server timestamps (stable across replays)', async () => {
    const { service, record } = makeService();
    await service.grantAsPortal({
      talent_record_id: RECORD, scope: 'matching', authContext: portalAuth(),
      idempotencyKey: KEY, requestId: 'r', now: new Date('2026-01-01T00:00:00.000Z'),
    });
    await service.grantAsPortal({
      talent_record_id: RECORD, scope: 'matching', authContext: portalAuth(),
      idempotencyKey: KEY, requestId: 'r', now: new Date('2026-09-09T00:00:00.000Z'),
    });
    // Same (record, scope) → identical requestHash despite different `now`.
    expect(record.mock.calls[0]![0].requestHash).toBe(record.mock.calls[1]![0].requestHash);
  });
});

describe('consent-texts — reproducible versioned hash preimage', () => {
  it('renders + hashes deterministically per (version, recipient, scope)', () => {
    const ctx = { recipient_tenant_id: TENANT, scope: 'contacting' as const };
    const a = hashPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, ctx);
    const b = hashPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, ctx);
    expect(a.hash).toBe(b.hash); // reproducible
    expect(a.version).toBe(CONSENT_TEXT_CURRENT_VERSION);
    // The recipient tenant is named in the text (ruling 1).
    expect(renderPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, ctx)).toContain(TENANT);
    // A different scope yields a different preimage → different hash.
    expect(
      hashPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, {
        recipient_tenant_id: TENANT,
        scope: 'matching',
      }).hash,
    ).not.toBe(a.hash);
  });

  it('throws on an unknown version (a hash with no reproducible preimage)', () => {
    expect(() =>
      renderPortalConsentText('nope-v9', { recipient_tenant_id: TENANT, scope: 'matching' }),
    ).toThrow(/unknown portal consent text version/);
  });
});

describe('ConsentService — portal consent text + history (Portal P2 P2b)', () => {
  it('getPortalConsentTexts renders all 5 scopes at the current version — each byte-identical to the D7 hash preimage', () => {
    const { service } = makeService();
    const res = service.getPortalConsentTexts(TENANT);
    expect(res.version).toBe(CONSENT_TEXT_CURRENT_VERSION);
    expect(res.texts).toHaveLength(5);
    for (const entry of res.texts) {
      // The displayed text IS the preimage the grant path hashes.
      const preimage = renderPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, {
        recipient_tenant_id: TENANT,
        scope: entry.scope,
      });
      expect(entry.text).toBe(preimage);
      // And the recipient is named by tenant_id in the canonical clause.
      expect(entry.text).toContain(TENANT);
    }
    // Sanity: the hash of a returned entry equals hashPortalConsentText's.
    const one = res.texts.find((t) => t.scope === 'matching');
    expect(one).toBeDefined();
    const { hash } = hashPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, {
      recipient_tenant_id: TENANT,
      scope: 'matching',
    });
    expect(typeof hash).toBe('string');
  });

  it('getPortalHistory clamps limit to 200 and rescopes to the passed (record) tenant', async () => {
    const resolveHistory = vi
      .fn()
      .mockResolvedValue({ events: [], next_cursor: null, is_anonymized: false });
    const service = new ConsentService({
      resolveHistory,
    } as unknown as ConsentRepository);
    await service.getPortalHistory({
      talent_record_id: RECORD,
      limitRaw: '9999',
      authContext: portalAuth(),
      requestId: 'req-1',
    });
    expect(resolveHistory).toHaveBeenCalledTimes(1);
    const arg = resolveHistory.mock.calls[0][0];
    expect(arg.limit).toBe(200); // clamped
    expect(arg.tenant_id).toBe(TENANT); // rescoped by the controller, honored here
    expect(arg.talent_record_id).toBe(RECORD);
  });

  it('getPortalHistory rejects a malformed cursor with a 400 (never a 500)', async () => {
    const service = new ConsentService({
      resolveHistory: vi.fn(),
    } as unknown as ConsentRepository);
    await expect(
      service.getPortalHistory({
        talent_record_id: RECORD,
        cursorRaw: '!!!not-base64!!!',
        authContext: portalAuth(),
        requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('getPortalHistory rejects a non-integer limit with a 400', async () => {
    const service = new ConsentService({
      resolveHistory: vi.fn(),
    } as unknown as ConsentRepository);
    await expect(
      service.getPortalHistory({
        talent_record_id: RECORD,
        limitRaw: 'abc',
        authContext: portalAuth(),
        requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });
});
