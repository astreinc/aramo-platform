import { describe, expect, it, vi } from 'vitest';
import { makeMockLogger } from '@aramo/common';

import {
  IdentityAuditRepository,
  type WriteAuditEventInput,
} from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';

function makeRepo(writeEvent: ReturnType<typeof vi.fn>): IdentityAuditRepository {
  return { writeEvent } as unknown as IdentityAuditRepository;
}

describe('IdentityAuditService.writeEvent', () => {
  // Test 1: delegates to IdentityAuditRepository.writeEvent with parameter passthrough.
  it('delegates to repository.writeEvent with mapped parameters', async () => {
    const writeEvent = vi.fn().mockResolvedValue({ id: 'audit-row-1' });
    const service = new IdentityAuditService(makeRepo(writeEvent), makeMockLogger());

    await service.writeEvent({
      event_type: 'identity.session.issued',
      actor_type: 'user',
      actor_id: USER_ID,
      tenant_id: TENANT_ID,
      subject_id: USER_ID,
      payload: { refresh_token_id: 'rt-1' },
    });

    expect(writeEvent).toHaveBeenCalledTimes(1);
    const firstCall = writeEvent.mock.calls[0];
    if (firstCall === undefined) throw new Error('writeEvent was not called');
    const arg = firstCall[0] as WriteAuditEventInput;
    expect(arg.event_type).toBe('identity.session.issued');
    expect(arg.actor_type).toBe('user');
    expect(arg.actor_id).toBe(USER_ID);
    expect(arg.tenant_id).toBe(TENANT_ID);
    expect(arg.subject_id).toBe(USER_ID);
    expect(arg.event_payload).toEqual({ refresh_token_id: 'rt-1' });
  });

  // Test 2: swallows repository errors and returns void (best-effort emission).
  it('swallows repository errors and returns void', async () => {
    const writeEvent = vi.fn().mockRejectedValue(new Error('db down'));
    const service = new IdentityAuditService(makeRepo(writeEvent), makeMockLogger());

    await expect(
      service.writeEvent({
        event_type: 'identity.session.refreshed',
        actor_type: 'user',
        actor_id: USER_ID,
        tenant_id: TENANT_ID,
        subject_id: USER_ID,
        payload: { old_refresh_token_id: 'rt-1', new_refresh_token_id: 'rt-2' },
      }),
    ).resolves.toBeUndefined();
  });

  // Test 3: logs at warn level with structured fields on failure.
  // M4-close HK-PR-4: warn call is now a structured AramoLogPayload (single
  // arg) — { event: 'identity_audit_write_failed', error_message, ... } —
  // not the prior 2-arg NestJS Logger ('message', fields) shape. Spy on
  // the injected AramoLogger mock's warn method directly rather than the
  // global Logger.prototype.
  it('logs at warn level with structured fields on failure', async () => {
    const writeEvent = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = makeMockLogger();
    const warnSpy = vi.fn();
    logger.warn = warnSpy;
    const service = new IdentityAuditService(makeRepo(writeEvent), logger);

    await service.writeEvent({
      event_type: 'identity.session.revoked',
      actor_type: 'user',
      actor_id: USER_ID,
      tenant_id: TENANT_ID,
      subject_id: USER_ID,
      payload: { reason: 'logout' },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0]!;
    expect(payload).toMatchObject({
      event: 'identity_audit_write_failed',
      error_message: 'boom',
      event_type: 'identity.session.revoked',
      actor_id: USER_ID,
      tenant_id: TENANT_ID,
      subject_id: USER_ID,
    });
  });

  // Test 4: repository accepts the 4 new event_types without closed-set violation.
  it('accepts all 4 new session.* event_types without closed-set violation', async () => {
    const writeEvent = vi.fn().mockResolvedValue({ id: 'audit-row' });
    const service = new IdentityAuditService(makeRepo(writeEvent), makeMockLogger());

    const event_types = [
      'identity.session.issued',
      'identity.session.refreshed',
      'identity.session.revoked',
      'identity.session.reuse_detected',
    ] as const;

    for (const event_type of event_types) {
      await service.writeEvent({
        event_type,
        actor_type: 'user',
        actor_id: USER_ID,
        tenant_id: TENANT_ID,
        subject_id: USER_ID,
        payload: {},
      });
    }

    expect(writeEvent).toHaveBeenCalledTimes(4);
  });

  // Test 5: tenant-scoped events carry tenant_id (4 new + 2 existing = 6 in mapping).
  it('passes tenant_id through for tenant-scoped session events', async () => {
    const writeEvent = vi.fn().mockResolvedValue({ id: 'r' });
    const service = new IdentityAuditService(makeRepo(writeEvent), makeMockLogger());

    await service.writeEvent({
      event_type: 'identity.session.reuse_detected',
      actor_type: 'user',
      actor_id: USER_ID,
      tenant_id: TENANT_ID,
      subject_id: USER_ID,
      payload: { presented_token_id: 'rt-old' },
    });

    const arg = writeEvent.mock.calls[0]![0] as WriteAuditEventInput;
    expect(arg.tenant_id).toBe(TENANT_ID);
  });
});
