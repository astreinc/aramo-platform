import type { PipelineRepository } from '@aramo/pipeline';
import type { RequisitionRepository } from '@aramo/requisition';
import type { TalentRecordRepository } from '@aramo/talent-record';
import type { ConsentService } from '@aramo/consent';
import type { AuthContextType } from '@aramo/auth';
import { describe, expect, it, vi } from 'vitest';

import { MeetingAssociationValidator } from '../microsoft/meeting-association.validator.js';
import { ConsentCalendarInviteGateAdapter } from '../microsoft/calendar-invite-consent-gate.adapter.js';
import { CalendarInviteConsentDeniedError } from '../microsoft/calendar-invite-consent-gate.port.js';

// COMM-C2B Amendment A1 (M365-SCHED-1, C-4/R1) — unit proofs for the shared
// association validator and the calendar-invitation consent gate. Fail-closed on
// cross-tenant records, on a Talent/Requisition that is not a real recruiting
// association, and on any consent result other than `allowed`.

const TENANT = '00000000-0000-0000-0000-0000000000a0';
const TALENT = '00000000-0000-0000-0000-0000000000b0';
const REQ = '00000000-0000-0000-0000-0000000000c0';

function validatorWith(opts: {
  talentInTenant: boolean;
  reqInTenant: boolean;
  liveEpisode: boolean;
}): MeetingAssociationValidator {
  const talents = {
    async findContactByIds(_t: string, ids: string[]): Promise<Map<string, { email: string }>> {
      const m = new Map<string, { email: string }>();
      if (opts.talentInTenant && ids.includes(TALENT)) m.set(TALENT, { email: 't@x.com' });
      return m;
    },
  } as unknown as TalentRecordRepository;
  const requisitions = {
    async findStatusById(): Promise<string | null> {
      return opts.reqInTenant ? 'open' : null;
    },
  } as unknown as RequisitionRepository;
  const pipelines = {
    async findLiveEpisode(): Promise<{ id: string } | null> {
      return opts.liveEpisode ? { id: 'ep-1' } : null;
    },
  } as unknown as PipelineRepository;
  return new MeetingAssociationValidator(talents, requisitions, pipelines);
}

const ARGS = { tenant_id: TENANT, talent_record_id: TALENT, requisition_id: REQ };

describe('MeetingAssociationValidator (A1 C-4)', () => {
  it('assertTenantOwnership resolves when both records belong to the tenant', async () => {
    await expect(
      validatorWith({ talentInTenant: true, reqInTenant: true, liveEpisode: false }).assertTenantOwnership(ARGS),
    ).resolves.toBeUndefined();
  });

  it('refuses a Talent that is not in the tenant (cross-tenant)', async () => {
    await expect(
      validatorWith({ talentInTenant: false, reqInTenant: true, liveEpisode: true }).assertTenantOwnership(ARGS),
    ).rejects.toMatchObject({ name: 'MeetingAssociationError', kind: 'talent_not_in_tenant' });
  });

  it('refuses a Requisition that is not in the tenant (cross-tenant)', async () => {
    await expect(
      validatorWith({ talentInTenant: true, reqInTenant: false, liveEpisode: true }).assertTenantOwnership(ARGS),
    ).rejects.toMatchObject({ name: 'MeetingAssociationError', kind: 'requisition_not_in_tenant' });
  });

  it('assertRecruitingAssociation resolves only with a LIVE pipeline episode linking the two', async () => {
    await expect(
      validatorWith({ talentInTenant: true, reqInTenant: true, liveEpisode: true }).assertRecruitingAssociation(ARGS),
    ).resolves.toBeUndefined();
  });

  it('refuses two independently-valid records that are NOT a recruiting association', async () => {
    await expect(
      validatorWith({ talentInTenant: true, reqInTenant: true, liveEpisode: false }).assertRecruitingAssociation(ARGS),
    ).rejects.toMatchObject({ name: 'MeetingAssociationError', kind: 'association_invalid' });
  });

  it('checks tenant ownership BEFORE the association (short-circuits on a cross-tenant Talent)', async () => {
    await expect(
      validatorWith({ talentInTenant: false, reqInTenant: true, liveEpisode: true }).assertRecruitingAssociation(ARGS),
    ).rejects.toMatchObject({ kind: 'talent_not_in_tenant' });
  });
});

describe('ConsentCalendarInviteGateAdapter (A1 R1)', () => {
  const authContext = {} as AuthContextType;
  const req = { tenant_id: TENANT, talent_record_id: TALENT, authContext, requestId: 'r-1' };

  function gateWith(result: 'allowed' | 'denied' | 'error') {
    const check = vi.fn().mockResolvedValue({ result });
    const consent = { check } as unknown as ConsentService;
    return { gate: new ConsentCalendarInviteGateAdapter(consent), check };
  }

  it('permits an invitation on an explicit `allowed` decision', async () => {
    const { gate, check } = gateWith('allowed');
    await expect(gate.assertInvitationAllowed(req)).resolves.toBeUndefined();
    // Reuses the ratified communication → contacting policy (channel=email).
    expect(check).toHaveBeenCalledWith(
      { talent_record_id: TALENT, operation: 'communication', channel: 'email' },
      undefined,
      authContext,
      'r-1',
    );
  });

  it('fails closed on a `denied` decision', async () => {
    const { gate } = gateWith('denied');
    await expect(gate.assertInvitationAllowed(req)).rejects.toBeInstanceOf(
      CalendarInviteConsentDeniedError,
    );
  });

  it('fails closed on an `error` decision (stale/invalid consent)', async () => {
    const { gate } = gateWith('error');
    await expect(gate.assertInvitationAllowed(req)).rejects.toMatchObject({ reason: 'error' });
  });
});
