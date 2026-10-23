import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';

// TALENT-INTEL-1 TI-1G §1 — the governed work-authorization evidence writer.
// Proves: an explicit recruiter status APPENDS a TalentWorkAuthorization assertion
// carrying ONLY the coarse status (NO inference of authorized_to_work_in / visa_type
// / requires_sponsorship). ATI-SEP-1 A1 — the writer is an ATS typed-row write
// ONLY: it no longer routes into the ledger (that projection moved to the
// TEMPORARY apps/api LegacyTrustProjectionService, never on the create path).

const TENANT = '01900000-0000-7000-8000-000000000001';
const TALENT = '01900000-0000-7000-8000-0000000000aa';

function makeService() {
  const createTalentWorkAuthorization = vi.fn().mockResolvedValue({ id: 'wa-1' });
  const evidence = { createTalentWorkAuthorization } as never;
  const generateDraft = vi.fn();
  const generateStructured = vi.fn();
  const svc = new TalentExtractionService(
    { generateDraft } as never,
    evidence,
    { generateStructured, providerKey: () => 'anthropic' } as never,
  );
  return { svc, createTalentWorkAuthorization, generateDraft, generateStructured };
}

describe('TalentExtractionService.recordDeclaredWorkAuthorization (TI-1G §1)', () => {
  it('appends a governed assertion with ONLY the coarse status — no inferred visa/sponsorship/countries', async () => {
    const { svc, createTalentWorkAuthorization, generateDraft, generateStructured } = makeService();
    await svc.recordDeclaredWorkAuthorization({
      talent_id: TALENT,
      tenant_id: TENANT,
      work_authorization_status: 'VISA_HOLDER',
      asserted_by: 'recruiter-1',
    });
    expect(createTalentWorkAuthorization).toHaveBeenCalledOnce();
    const arg = createTalentWorkAuthorization.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['talent_id']).toBe(TALENT);
    expect(arg['tenant_id']).toBe(TENANT);
    expect(arg['work_authorization_status']).toBe('VISA_HOLDER');
    // NO inference — the decomposed fields stay at empty/false defaults.
    expect(arg['authorized_to_work_in']).toEqual([]);
    expect(arg['requires_sponsorship']).toBe(false);
    expect(arg['visa_type']).toBeUndefined();
    expect(typeof arg['id']).toBe('string'); // fresh row id → append-only history
    // No model call — governed writer reads the recruiter statement, never a model.
    expect(generateDraft).not.toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('ATI-SEP-1 A1 — writes the typed row ONLY: no ledger read/route, no trust surface', async () => {
    const { svc, createTalentWorkAuthorization } = makeService();
    await svc.recordDeclaredWorkAuthorization({
      talent_id: TALENT,
      tenant_id: TENANT,
      work_authorization_status: 'US_CITIZEN',
      asserted_by: 'recruiter-1',
    });
    // The evidence stub exposes ONLY createTalentWorkAuthorization — any ledger
    // fan-out (a *ForLedger read) would have thrown on the missing method.
    expect(createTalentWorkAuthorization).toHaveBeenCalledOnce();
    expect(Reflect.get(svc, 'trust')).toBeUndefined();
    expect(Reflect.get(svc, 'routeDeclaredEvidenceToLedger')).toBeUndefined();
  });
});
