import { describe, expect, it, vi } from 'vitest';

import { ClientSubmittalPolicyController } from '../../client-submittal-policy/client-submittal-policy.controller.js';

// A Right to Represent is only satisfiable through Aramo Sign (DOC-5 gate: an RTR
// EXECUTED via e-sign) and sending one needs the Sign subscription. Publishing a
// policy that REQUIRES rtr_present for a tenant without Sign would deadlock every
// submittal it governs, so the publish is refused (422 RTR_REQUIRES_SIGN).

const AUTH = { sub: 'u1', tenant_id: 't1', consumer_type: 'recruiter', actor_kind: 'user', scopes: [], iat: 0, exp: 0 } as never;

function make(caps: string[]) {
  const publish = vi.fn().mockResolvedValue({ id: 'p1' });
  const controller = new ClientSubmittalPolicyController(
    { publish } as never,
    { isClientCompany: async () => true } as never,
    { getCapabilities: async () => new Set(caps) } as never,
  );
  return { controller, publish };
}

const dto = (disposition: 'REQUIRED' | 'NOT_REQUIRED') =>
  ({ scope: 'CLIENT', scope_ref: 'c1', version: 1, requirements: [{ key: 'rtr_present', disposition, override_class: 'LOCKED' }] }) as never;

describe('Client Submittal Policy publish — RTR needs Aramo Sign', () => {
  it('refuses RTR REQUIRED when the tenant has no Sign subscription', async () => {
    const { controller, publish } = make(['core', 'ats']);
    await expect(controller.publish(dto('REQUIRED'), AUTH, 'r1')).rejects.toMatchObject({
      code: 'CLIENT_SUBMITTAL_POLICY_INVALID',
      statusCode: 422,
      context: { details: { reason: 'RTR_REQUIRES_SIGN' } },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('allows RTR REQUIRED with Sign, and RTR NOT_REQUIRED without it', async () => {
    const withSign = make(['core', 'ats', 'esign']);
    await withSign.controller.publish(dto('REQUIRED'), AUTH, 'r1');
    expect(withSign.publish).toHaveBeenCalledTimes(1);
    const noSign = make(['core', 'ats']);
    await noSign.controller.publish(dto('NOT_REQUIRED'), AUTH, 'r1');
    expect(noSign.publish).toHaveBeenCalledTimes(1);
  });
});
