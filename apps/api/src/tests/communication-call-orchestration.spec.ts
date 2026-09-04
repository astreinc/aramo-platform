import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { CommunicationCallService } from '../communications/communication-call.service.js';
import type { InitiateCommunicationCallDto } from '../communications/dto/communications.dto.js';

// COMM-C2A — unit proofs for the call orchestration: reliable Talent × Requisition
// × Pipeline association (R5) and the governed no_contact→contacted CONTACT side
// effect (R6). Fail-closed consent + best-effort (evidence-preserving) transition
// are asserted directly. HTTP authz + the real DB path ride the integration spec.

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const RECRUITER = '00000000-0000-7000-8000-0000000000u1';
const TALENT = '00000000-0000-7000-8000-0000000000t1';
const REQ = '00000000-0000-7000-8000-0000000000r1';
const PIPELINE = '00000000-0000-7000-8000-0000000000p1';

function interactionRow(status: string) {
  return {
    id: 'int-1',
    channel: 'voice',
    direction: 'outbound',
    status,
    integration_connection_id: 'conn-1',
    from_address: '+15715550100',
    to_address: '+17035550111',
    started_at: null,
    ringing_at: null,
    connected_at: null,
    ended_at: null,
    duration_seconds: null,
    created_at: new Date('2026-09-04T00:00:00Z'),
    updated_at: new Date('2026-09-04T00:00:00Z'),
  };
}

function pipelineView(over: Record<string, unknown> = {}) {
  return {
    id: PIPELINE,
    tenant_id: TENANT,
    requisition_id: REQ,
    talent_record_id: TALENT,
    status: 'no_contact',
    version: 0,
    ...over,
  };
}

function makeService(opts: {
  consentResult?: string;
  pipeline?: Record<string, unknown> | null;
  scopes?: string[];
  applyActionRejects?: boolean;
}) {
  const applyAction = vi.fn(async () => pipelineView({ status: 'contacted', version: 1 }));
  if (opts.applyActionRejects) applyAction.mockRejectedValue(new Error('PIPELINE_TRANSITION_CONFLICT'));

  const pipelines = {
    findByIdForActor: vi.fn(async () => (opts.pipeline === undefined ? pipelineView() : opts.pipeline)),
    applyAction,
  } as unknown as ConstructorParameters<typeof CommunicationCallService>[7];

  const talentRecords = {
    findDialablePhonesForTenant: vi.fn(async () => ({
      phone_cell: '+17035550111',
      phone_work: null,
      phone_home: null,
    })),
  } as unknown as ConstructorParameters<typeof CommunicationCallService>[0];

  const associate = vi.fn(async () => ({ id: 'assoc' }));
  const comms = {
    createOutboundInteraction: vi.fn(async () => interactionRow('created')),
    associate,
    transition: vi.fn(async () => interactionRow('initiated')),
  } as unknown as ConstructorParameters<typeof CommunicationCallService>[1];

  const repo = {
    findProviderIdentityByRecruiter: vi.fn(async () => ({
      provider_user_id: 'pv-user-1',
      provider_extension_id: null,
      extension: null,
      display_phone_number: '+15715550100',
    })),
  } as unknown as ConstructorParameters<typeof CommunicationCallService>[2];

  const connections = {
    findConnectionByProviderKey: vi.fn(async () => ({ id: 'conn-1', provider_key: 'zoom_phone' })),
  } as unknown as ConstructorParameters<typeof CommunicationCallService>[3];

  const initiateCall = vi.fn(async () => ({ launch_mode: 'zoom_embed' }));
  const providers = {
    resolve: vi.fn(() => ({ initiateCall })),
  } as unknown as ConstructorParameters<typeof CommunicationCallService>[4];

  const consent = {
    check: vi.fn(async () => ({ result: opts.consentResult ?? 'allowed' })),
  } as unknown as ConstructorParameters<typeof CommunicationCallService>[5];

  const requisitions = {
    exists: vi.fn(async () => true),
  } as unknown as ConstructorParameters<typeof CommunicationCallService>[6];

  const service = new CommunicationCallService(
    talentRecords,
    comms,
    repo,
    connections,
    providers,
    consent,
    requisitions,
    pipelines,
  );

  const auth = {
    tenant_id: TENANT,
    sub: RECRUITER,
    scopes: opts.scopes ?? ['communication:voice:call', 'pipeline:change-status'],
  } as unknown as AuthContextType;

  return { service, auth, comms, consent, pipelines, associate, applyAction };
}

const DTO: InitiateCommunicationCallDto = {
  talent_id: TALENT,
  phone_slot: 'cell',
  regarding: { requisition_id: REQ, pipeline_id: PIPELINE },
};

describe('CommunicationCallService — COMM-C2A orchestration', () => {
  it('writes talent + requisition + pipeline associations and drives governed CONTACT (no_contact)', async () => {
    const { service, auth, associate, applyAction } = makeService({});
    await service.initiate(auth, DTO, 'req-1', null);
    // Three associations: talent(subject), requisition(regarding), pipeline(regarding).
    expect(associate).toHaveBeenCalledTimes(3);
    const subjectTypes = associate.mock.calls.map((c) => (c[0] as { subject_type: string }).subject_type);
    expect(subjectTypes).toEqual(['talent_record', 'requisition', 'pipeline']);
    // Governed CONTACT via the state machine with the read CAS version.
    expect(applyAction).toHaveBeenCalledTimes(1);
    expect(applyAction.mock.calls[0][0]).toMatchObject({
      action: 'CONTACT',
      expected_version: 0,
      changed_by_id: RECRUITER,
    });
  });

  it('fail-closed consent denies before any interaction or CONTACT', async () => {
    const { service, auth, comms, applyAction } = makeService({ consentResult: 'denied' });
    await expect(service.initiate(auth, DTO, 'req-2', null)).rejects.toMatchObject({
      code: 'COMMUNICATION_CALL_CONSENT_DENIED',
      statusCode: 403,
    });
    expect((comms as unknown as { createOutboundInteraction: ReturnType<typeof vi.fn> }).createOutboundInteraction).not.toHaveBeenCalled();
    expect(applyAction).not.toHaveBeenCalled();
  });

  it('does NOT replay CONTACT when the pipeline is already past no_contact', async () => {
    const { service, auth, applyAction, associate } = makeService({ pipeline: pipelineView({ status: 'contacted', version: 3 }) });
    await service.initiate(auth, DTO, 'req-3', null);
    expect(associate).toHaveBeenCalledTimes(3); // evidence still recorded
    expect(applyAction).not.toHaveBeenCalled(); // no regression/replay
  });

  it('does NOT advance the pipeline without pipeline:change-status authority', async () => {
    const { service, auth, applyAction } = makeService({ scopes: ['communication:voice:call'] });
    await service.initiate(auth, DTO, 'req-4', null);
    expect(applyAction).not.toHaveBeenCalled();
  });

  it('preserves the call/evidence when the CONTACT transition conflicts (CAS)', async () => {
    const { service, auth, applyAction } = makeService({ applyActionRejects: true });
    // The call resolves normally — a failed transition is swallowed, not surfaced.
    const view = await service.initiate(auth, DTO, 'req-5', null);
    expect(view.id).toBe('int-1');
    expect(applyAction).toHaveBeenCalledTimes(1);
  });

  it('refuses a call whose pipeline does not match the talent × requisition (R5)', async () => {
    const { service, auth } = makeService({ pipeline: null });
    await expect(service.initiate(auth, DTO, 'req-6', null)).rejects.toMatchObject({
      code: 'COMMUNICATION_CALL_NOT_INITIABLE',
    });
  });
});
