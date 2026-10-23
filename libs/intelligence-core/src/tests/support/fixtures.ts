import type { TalentIngestRequest } from '@aramo/intelligence-contracts';

// Shared ingestion fixtures (unit + integration specs).

let seq = 0;
export const nextEventId = (): string => `evt-${Date.now()}-${++seq}`;

export const VERIFIED = {
  status: 'VERIFIED',
  method: 'EMAIL_OTP',
  source: 'ARAMO_PORTAL',
  verified_at: '2026-10-01T00:00:00.000Z',
} as const;

export function snapshot(over: Partial<TalentIngestRequest> & { tenant?: string; talent?: string } = {}): TalentIngestRequest {
  const { tenant, talent, ...rest } = over;
  return {
    source_system_id: 'ARAMO_ATS',
    source_tenant_id: tenant ?? 'tenant-a',
    external_talent_id: talent ?? 'talent-1',
    source_event_id: nextEventId(),
    occurred_at: '2026-10-23T10:00:00.000Z',
    identity: {
      names: { first: 'Priya', last: 'Raman' },
      emails: [{ value: 'priya@example.com', is_primary: true, verification: { ...VERIFIED } }],
      phones: [{ value: '+1 555 010 2000', is_primary: true }],
    },
    assertions: [
      { assertion_type: 'SKILL', payload: { name: 'TypeScript' }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00.000Z' },
      { assertion_type: 'TITLE', payload: { value: 'Engineer' }, source_kind: 'RECRUITER', observed_at: '2026-10-23T10:00:00.000Z' },
    ],
    ...rest,
  };
}
