import { describe, it, expect, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { SubmitTalentController } from '../submit-talent/submit-talent.controller.js';

// INC-1d (TIP-E2E) — manual-handoff integrity at the HTTP send boundary. The
// recruiter MUST attest handoff_performed:true (the manual client handoff actually
// occurred — the platform transmits nothing) and MUST supply a delivery_channel.
// Both are enforced in submitImpl BEFORE the mutation command runs, for the
// submit-to-client route AND its submit-to-ats alias (they share submitImpl), so a
// non-attested / channel-less send never enters the transaction. This is an ATTESTED
// + RECORDED handoff — never represented as an independently-verified client receipt.

const TENANT = '11111111-1111-7111-8111-111111111111';
const SUBMITTAL_ID = '22222222-2222-7222-8222-222222222222';
const RECRUITER = '77777777-7777-7777-8777-777777777777';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00';
const IDEMPOTENCY_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f01';

function makeAuth(over: Partial<AuthContextType> = {}): AuthContextType {
  return {
    sub: RECRUITER,
    consumer_type: 'recruiter',
    actor_kind: 'user',
    tenant_id: TENANT,
    scopes: ['submittal:approve'],
    iat: 0,
    exp: 0,
    ...over,
  };
}

function reqFake(): never {
  return { resolveVisibleRequisitionIds: vi.fn().mockResolvedValue(null) } as unknown as never;
}

function build() {
  const submitToClient = vi.fn().mockResolvedValue(undefined);
  const command = { submitToClient };
  const submittalRepository = {
    findById: vi.fn().mockResolvedValue({ id: SUBMITTAL_ID, state: 'submitted_to_client' }),
  };
  const eventRepository = { findByTenantAndId: vi.fn().mockResolvedValue({ id: 'evt-1' }) };
  const idempotency = {
    lookup: vi.fn().mockResolvedValue({ kind: 'proceed' }),
    persist: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new SubmitTalentController(
    command as never,
    submittalRepository as never,
    eventRepository as never,
    idempotency as never,
  );
  return { controller, submitToClient };
}

describe('SubmitTalentController — INC-1d manual-handoff attestation (send boundary)', () => {
  it('missing handoff_performed → ATTESTATION_MISSING (422), mutation command NOT called', async () => {
    const { controller, submitToClient } = build();
    await expect(
      controller.submitToClient(
        SUBMITTAL_ID,
        { delivery_channel: 'manual_email' },
        IDEMPOTENCY_KEY,
        makeAuth(),
        REQUEST_ID,
        reqFake(),
      ),
    ).rejects.toMatchObject({ code: 'ATTESTATION_MISSING', statusCode: 422 });
    expect(submitToClient).not.toHaveBeenCalled();
  });

  it('handoff_performed not the literal true (e.g. string "true") → ATTESTATION_MISSING, no command', async () => {
    const { controller, submitToClient } = build();
    await expect(
      controller.submitToClient(
        SUBMITTAL_ID,
        { handoff_performed: 'true', delivery_channel: 'manual_email' },
        IDEMPOTENCY_KEY,
        makeAuth(),
        REQUEST_ID,
        reqFake(),
      ),
    ).rejects.toMatchObject({ code: 'ATTESTATION_MISSING', statusCode: 422 });
    expect(submitToClient).not.toHaveBeenCalled();
  });

  it('attested but delivery_channel missing → SUBMITTAL_DELIVERY_CHANNEL_INVALID (422, required), no command', async () => {
    const { controller, submitToClient } = build();
    await expect(
      controller.submitToClient(
        SUBMITTAL_ID,
        { handoff_performed: true },
        IDEMPOTENCY_KEY,
        makeAuth(),
        REQUEST_ID,
        reqFake(),
      ),
    ).rejects.toMatchObject({
      code: 'SUBMITTAL_DELIVERY_CHANNEL_INVALID',
      statusCode: 422,
      context: { details: { reason: 'required' } },
    });
    expect(submitToClient).not.toHaveBeenCalled();
  });

  it('attested + channel → passes the boundary and invokes the command with the attestation', async () => {
    const { controller, submitToClient } = build();
    await controller.submitToClient(
      SUBMITTAL_ID,
      { handoff_performed: true, delivery_channel: 'manual_vms' },
      IDEMPOTENCY_KEY,
      makeAuth(),
      REQUEST_ID,
      reqFake(),
    );
    expect(submitToClient).toHaveBeenCalledTimes(1);
    const arg = submitToClient.mock.calls[0]?.[0] as {
      handoff_performed: boolean;
      delivery_channel: string;
    };
    expect(arg.handoff_performed).toBe(true);
    expect(arg.delivery_channel).toBe('manual_vms');
  });

  it('the submit-to-ats ALIAS enforces the SAME attestation policy (equivalent mutation)', async () => {
    const { controller, submitToClient } = build();
    await expect(
      controller.submitToAts(
        SUBMITTAL_ID,
        { delivery_channel: 'manual_email' },
        IDEMPOTENCY_KEY,
        makeAuth(),
        REQUEST_ID,
        reqFake(),
      ),
    ).rejects.toMatchObject({ code: 'ATTESTATION_MISSING', statusCode: 422 });
    expect(submitToClient).not.toHaveBeenCalled();
  });
});
