import { describe, expect, it, vi } from 'vitest';

import type { ConsentRepository } from '../lib/consent.repository.js';
import { ConsentService } from '../lib/consent.service.js';

// CI-B5Z — the narrow internal enforcement method delegates to the SAME
// canonical decision logic (resolveConsentState) as the HTTP check() path, with
// NO HTTP user identity — only tenant_id + talent_record_id + operation.

describe('ConsentService.checkOperationForService (CI-B5Z internal enforcement)', () => {
  it('delegates to resolveConsentState with tenant/talent/operation, no idempotency key', async () => {
    const resolveConsentState = vi.fn(async () => ({ result: 'allowed' as const, decision_id: 'd1' }));
    const repo = { resolveConsentState } as unknown as ConsentRepository;
    const svc = new ConsentService(repo);

    const out = await svc.checkOperationForService({
      tenant_id: 'tenant-1',
      talent_record_id: 'talent-1',
      operation: 'transcription',
    });

    expect(out.result).toBe('allowed');
    expect(resolveConsentState).toHaveBeenCalledTimes(1);
    const arg = resolveConsentState.mock.calls[0][0] as Record<string, unknown>;
    expect(arg['tenant_id']).toBe('tenant-1');
    expect(arg['talent_record_id']).toBe('talent-1');
    expect(arg['operation']).toBe('transcription');
    expect(arg['idempotencyKey']).toBeUndefined();
    expect(typeof arg['requestHash']).toBe('string');
    expect(typeof arg['requestId']).toBe('string');
  });

  it('recording and transcription are independent operations', async () => {
    const resolveConsentState = vi.fn(async (input: { operation: string }) => ({
      result: input.operation === 'recording' ? ('denied' as const) : ('allowed' as const),
      decision_id: 'd',
    }));
    const svc = new ConsentService({ resolveConsentState } as unknown as ConsentRepository);
    expect((await svc.checkOperationForService({ tenant_id: 't', talent_record_id: 'x', operation: 'recording' })).result).toBe('denied');
    expect((await svc.checkOperationForService({ tenant_id: 't', talent_record_id: 'x', operation: 'transcription' })).result).toBe('allowed');
  });
});
