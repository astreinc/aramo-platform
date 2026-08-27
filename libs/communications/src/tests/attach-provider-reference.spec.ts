import { describe, expect, it, vi } from 'vitest';

import { CommunicationsService } from '../lib/communications.service.js';
import {
  CommunicationInteractionNotFoundError,
  CommunicationProviderReferenceConflictError,
} from '../lib/domain/errors.js';
import type { InteractionRow } from '../lib/communications.repository.js';

// COMM-B8 — the provider-reference capture is CONVERGENT-or-conflict:
//   null → value        : fill (write)
//   value === same value : no-op (no write)
//   value → different    : CONFLICT (refuse, no write) — protects correlation
// It is tenant+owner-safe (interaction must belong to the tenant AND have been
// initiated by the calling recruiter; otherwise a tenant-safe NOT FOUND), and it
// writes ONLY the provider_call_* fields — never status/timestamps/disposition.

const TENANT = 't1';
const RECRUITER = 'r1';
const INTX = 'i1';

function row(overrides: Partial<InteractionRow> = {}): InteractionRow {
  return {
    id: INTX,
    tenant_id: TENANT,
    site_id: null,
    channel: 'voice',
    direction: 'outbound',
    status: 'initiated',
    integration_connection_id: 'c1',
    provider_interaction_id: null,
    provider_call_id: null,
    provider_call_history_uuid: null,
    provider_call_element_id: null,
    initiated_by_id: RECRUITER,
    from_address: '+15715550100',
    to_address: '+17035550111',
    started_at: null,
    ringing_at: null,
    connected_at: null,
    ended_at: null,
    duration_seconds: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function svc(current: InteractionRow | null) {
  const setProviderReference = vi.fn().mockResolvedValue(1);
  const repo = {
    findInteractionForTenant: vi.fn().mockResolvedValue(current),
    setProviderReference,
  };
  return { service: new CommunicationsService(repo as never), setProviderReference, repo };
}

describe('CommunicationsService.attachProviderReference', () => {
  it('fills a previously-null correlation field (write)', async () => {
    const { service, setProviderReference } = svc(row());
    await service.attachProviderReference(TENANT, RECRUITER, INTX, { provider_call_element_id: 'e-1' });
    expect(setProviderReference).toHaveBeenCalledWith(TENANT, INTX, { provider_call_element_id: 'e-1' });
  });

  it('is a no-op when the same value is re-attached (no write)', async () => {
    const { service, setProviderReference } = svc(row({ provider_call_element_id: 'e-1' }));
    await service.attachProviderReference(TENANT, RECRUITER, INTX, { provider_call_element_id: 'e-1' });
    expect(setProviderReference).not.toHaveBeenCalled();
  });

  it('REFUSES replacing an already-set field with a different value (conflict, no write)', async () => {
    const { service, setProviderReference } = svc(row({ provider_call_element_id: 'e-1' }));
    await expect(
      service.attachProviderReference(TENANT, RECRUITER, INTX, { provider_call_element_id: 'e-DIFFERENT' }),
    ).rejects.toBeInstanceOf(CommunicationProviderReferenceConflictError);
    expect(setProviderReference).not.toHaveBeenCalled();
  });

  it('fills only the null fields when mixing fill + same-value', async () => {
    const { service, setProviderReference } = svc(row({ provider_call_id: 'c-1' }));
    await service.attachProviderReference(TENANT, RECRUITER, INTX, {
      provider_call_id: 'c-1', // same → no-op
      provider_call_history_uuid: 'h-1', // null → fill
    });
    expect(setProviderReference).toHaveBeenCalledWith(TENANT, INTX, { provider_call_history_uuid: 'h-1' });
  });

  it('conflicts atomically — one conflicting field refuses the whole write', async () => {
    const { service, setProviderReference } = svc(row({ provider_call_id: 'c-1' }));
    await expect(
      service.attachProviderReference(TENANT, RECRUITER, INTX, {
        provider_call_history_uuid: 'h-1', // would fill
        provider_call_id: 'c-DIFFERENT', // conflicts
      }),
    ).rejects.toBeInstanceOf(CommunicationProviderReferenceConflictError);
    expect(setProviderReference).not.toHaveBeenCalled();
  });

  it('tenant-safe NOT FOUND when the interaction is absent/cross-tenant', async () => {
    const { service } = svc(null);
    await expect(
      service.attachProviderReference(TENANT, RECRUITER, INTX, { provider_call_element_id: 'e-1' }),
    ).rejects.toBeInstanceOf(CommunicationInteractionNotFoundError);
  });

  it('owner-safe NOT FOUND when the interaction was initiated by a different recruiter', async () => {
    const { service, setProviderReference } = svc(row({ initiated_by_id: 'other-recruiter' }));
    await expect(
      service.attachProviderReference(TENANT, RECRUITER, INTX, { provider_call_element_id: 'e-1' }),
    ).rejects.toBeInstanceOf(CommunicationInteractionNotFoundError);
    expect(setProviderReference).not.toHaveBeenCalled();
  });
});
