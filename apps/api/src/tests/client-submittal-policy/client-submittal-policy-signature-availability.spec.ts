import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import type { ClientSubmittalPolicyService } from '@aramo/client-submittal-policy';
import type { CompanyClientCheckPort } from '@aramo/requisition';

import { ClientSubmittalPolicyController } from '../../client-submittal-policy/client-submittal-policy.controller.js';
import type { SignatureAvailabilityService } from '../../document-signing/signature-availability.service.js';

// Multi-Provider directive §D — requiring a Right to Represent is refused when the
// tenant has no way to send one (no provider, no subscription, provider not built).
// A temporary condition (allowance used up, provider disconnected) never blocks
// authoring: it blocks the send, and the RTR requirement stays enforced.

const AUTH = { tenant_id: 't1', sub: 'u1', scopes: [] } as unknown as AuthContextType;

function make(reason: string | null) {
  const policy = { publish: vi.fn(async () => ({ id: 'p1' })) } as unknown as ClientSubmittalPolicyService;
  const check = { isClientCompany: vi.fn(async () => true) } as unknown as CompanyClientCheckPort;
  const availability = {
    evaluate: vi.fn(async () => ({ provider: 'aramo_sign', available: reason === null, reason, allowance: null })),
  } as unknown as SignatureAvailabilityService;
  return { controller: new ClientSubmittalPolicyController(policy, check, availability), policy, availability };
}

const dto = (disposition: 'REQUIRED' | 'NOT_REQUIRED', key = 'rtr_present') =>
  ({ scope: 'TENANT', version: '1', requirements: [{ key, disposition, override_class: 'HARD_DENY' }] }) as never;

describe('ClientSubmittalPolicyController.publish — RTR needs a working signature provider', () => {
  it.each(['NOT_SUBSCRIBED', 'NO_PROVIDER', 'PROVIDER_UNAVAILABLE'])('refuses Required RTR when %s', async (reason) => {
    const { controller, policy } = make(reason);
    await expect(controller.publish(dto('REQUIRED'), AUTH, 'r1')).rejects.toMatchObject({
      code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
      statusCode: 422,
      context: { details: { reason: 'RTR_REQUIRES_SIGN', key: 'rtr_present', signature_reason: reason } },
    });
    expect(policy.publish).not.toHaveBeenCalled();
  });

  it.each(['LIMIT_REACHED', 'PROVIDER_DISCONNECTED', null])('allows Required RTR when the signature state is %s', async (reason) => {
    const { controller, policy } = make(reason);
    await expect(controller.publish(dto('REQUIRED'), AUTH, 'r1')).resolves.toBeDefined();
    expect(policy.publish).toHaveBeenCalled();
  });

  it('does not consult signing for other requirements or a Not-required RTR', async () => {
    const { controller, availability } = make('NOT_SUBSCRIBED');
    await controller.publish(dto('NOT_REQUIRED'), AUTH, 'r1');
    await controller.publish(dto('REQUIRED', 'resume_selected'), AUTH, 'r1');
    expect(availability.evaluate).not.toHaveBeenCalled();
  });
});
