import { describe, expect, it } from 'vitest';

import { TalentDossierReadAdapter } from '../talent-intelligence/talent-dossier-read.adapter.js';
import type { DossierService } from '../talent-identity/dossier.service.js';

// TIP-E2E INC-2 §3.3 / §6 — the dossier adapter PRESENTS existing DossierService
// outcomes (verifications + advisory pointers + ledger_established). It delegates;
// it never recomputes trust or exposes internal machinery.
const TENANT = '11111111-1111-7111-8111-111111111111';
const RECORD = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

describe('TalentDossierReadAdapter (INC-2 §3.3)', () => {
  it('delegates to DossierService and maps the recruiter-facing outcome', async () => {
    const dossier = {
      getDossier: async (tenant_id: string, recordId: string) => {
        expect(tenant_id).toBe(TENANT);
        expect(recordId).toBe(RECORD);
        return {
          ledger_established: true,
          dimensions: { identity: null, claims: null, continuity: null, eligibility: null },
          statements: [],
          verifications: [
            { anchor_kind: 'EMAIL', status: 'CONFIRMED' },
            { anchor_kind: 'PHONE', status: 'PENDING' },
          ],
          advisory_pointers: ['adv-1'],
        };
      },
    } as unknown as DossierService;
    const head = await new TalentDossierReadAdapter(dossier).getDossierHead({
      tenant_id: TENANT,
      talent_record_id: RECORD,
    });
    expect(head.ledger_established).toBe(true);
    expect(head.talent_record_id).toBe(RECORD);
    expect(head.verifications).toEqual([
      { anchor_kind: 'EMAIL', status: 'CONFIRMED' },
      { anchor_kind: 'PHONE', status: 'PENDING' },
    ]);
    expect(head.advisory_pointers).toEqual(['adv-1']);
  });

  it('no trust subject → ledger_established:false (not an error)', async () => {
    const dossier = {
      getDossier: async () => ({
        ledger_established: false,
        dimensions: { identity: null, claims: null, continuity: null, eligibility: null },
        statements: [],
        verifications: [],
        advisory_pointers: [],
      }),
    } as unknown as DossierService;
    const head = await new TalentDossierReadAdapter(dossier).getDossierHead({
      tenant_id: TENANT,
      talent_record_id: RECORD,
    });
    expect(head.ledger_established).toBe(false);
    expect(head.verifications).toEqual([]);
  });
});
