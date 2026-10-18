import { describe, expect, it, vi } from 'vitest';

import { ClientSubmittalPolicyController } from '../../client-submittal-policy/client-submittal-policy.controller.js';
import { SignatureAvailabilityService } from '../../document-signing/signature-availability.service.js';

// A Right to Represent is only satisfiable through an executed signature (DOC-5
// gate) and sending one through Aramo Sign needs the Sign subscription. Publishing a
// policy that REQUIRES rtr_present for a tenant without Sign would deadlock every
// submittal it governs, so the publish is refused (422 RTR_REQUIRES_SIGN).
//
// Composed through the REAL SignatureAvailabilityService (Multi-Provider §D), which
// superseded the capability-only check: no `esign` capability reads NOT_SUBSCRIBED.

const AUTH = { sub: 'u1', tenant_id: 't1', consumer_type: 'recruiter', actor_kind: 'user', scopes: [], iat: 0, exp: 0 } as never;
const ALLOWANCE = {
  getStatus: async () => ({
    subscribed: true,
    plan_key: 'aramo-sign-included-v1',
    allowance_key: 'esign.envelopes',
    limit: 100,
    used: 0,
    remaining: 100,
    period_start: new Date('2026-10-01T00:00:00Z'),
    period_end: new Date('2026-11-01T00:00:00Z'),
    threshold: 'OK',
  }),
};

function make(caps: string[]) {
  const publish = vi.fn().mockResolvedValue({ id: 'p1' });
  const availability = new SignatureAvailabilityService(
    { getSelectedProvider: async () => ({ provider: 'aramo_sign', explicit: false }) } as never,
    { getCapabilities: async () => new Set(caps) } as never,
    ALLOWANCE as never,
    new Map([['aramo_sign', {} as never]]),
  );
  const controller = new ClientSubmittalPolicyController(
    { publish } as never,
    { isClientCompany: async () => true } as never,
    availability,
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
      context: { details: { reason: 'RTR_REQUIRES_SIGN', signature_reason: 'NOT_SUBSCRIBED' } },
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
