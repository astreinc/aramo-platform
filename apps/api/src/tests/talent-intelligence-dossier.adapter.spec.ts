import { describe, expect, it } from 'vitest';

import { TalentDossierReadAdapter } from '../talent-intelligence/talent-dossier-read.adapter.js';
import type { DossierService } from '../talent-identity/dossier.service.js';

// TIP-E2E INC-2 §3.3 / §6 → ATI-SEP-1 T10 WP3b — the dossier adapter PRESENTS
// DossierService outcomes (now Talent Intelligence's view): the contact
// verification outcomes + ledger_established. Advisory pointers are no longer a
// trust read (ATS-local advisories, WP2) — always empty here.
const TENANT = '11111111-1111-7111-8111-111111111111';
const RECORD = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

describe('TalentDossierReadAdapter (INC-2 §3.3, T10 WP3b)', () => {
  it('delegates to DossierService and maps the recruiter-facing outcome', async () => {
    const dossier = {
      getDossier: async (tenant_id: string, recordId: string) => {
        expect(tenant_id).toBe(TENANT);
        expect(recordId).toBe(RECORD);
        return {
          ledger_established: true,
          intelligence_status: 'ENABLED',
          verifications: [
            { anchor_kind: 'EMAIL', status: 'VERIFIED', disputed: false },
            { anchor_kind: 'PHONE', status: 'DECLARED', disputed: false },
          ],
        };
      },
    } as unknown as DossierService;
    const head = await new TalentDossierReadAdapter(dossier).getDossierHead({ tenant_id: TENANT, talent_record_id: RECORD });
    expect(head.ledger_established).toBe(true);
    expect(head.talent_record_id).toBe(RECORD);
    expect(head.verifications).toEqual([
      { anchor_kind: 'EMAIL', status: 'VERIFIED' },
      { anchor_kind: 'PHONE', status: 'DECLARED' },
    ]);
    expect(head.advisory_pointers).toEqual([]);
  });

  it('TI not enabled → ledger_established:false (not an error)', async () => {
    const dossier = {
      getDossier: async () => ({ ledger_established: false, intelligence_status: 'NOT_ENTITLED', verifications: [] }),
    } as unknown as DossierService;
    const head = await new TalentDossierReadAdapter(dossier).getDossierHead({ tenant_id: TENANT, talent_record_id: RECORD });
    expect(head.ledger_established).toBe(false);
    expect(head.verifications).toEqual([]);
  });
});
