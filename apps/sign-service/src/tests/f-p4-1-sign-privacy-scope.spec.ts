import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignPrivacyExecutionService } from '../app/privacy/sign-privacy-execution.service.js';

// Retention and Purge directive (ebd41d99) W9 / finding F-P4-1 — the Sign deletion path
// asks the dependency inspector for the Sign scope, which never reads an ATS schema
// (aramo_sign has no grant on documents). Driven to the inspection on a held tenant so
// nothing is deleted.

const FLAG = 'SIGN_PRIVACY_DELETION_EXECUTION_ENABLED';

describe('F-P4-1 — Sign privacy execution uses the Sign inspector scope', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("calls inspect(user, tenant, { scope: 'sign' }) and holds on the identity legal hold", async () => {
    process.env[FLAG] = '1';
    const req = { id: 'r-1', product: 'SIGN', request_type: 'DELETION', status: 'EXECUTING', subject_user_id: 'u-1', subject_tenant_id: 't-1' };
    const requests = {
      findById: vi.fn(async () => req),
      recordEvent: vi.fn(async () => undefined),
      transition: vi.fn(async () => ({ ...req, status: 'DATA_INVENTORY' })),
    };
    const subjects = {
      context: vi.fn(async () => ({ user_id: 'u-1', tenant_id: 't-1', tenant_kind: 'PERSONAL', role_keys: ['tenant_owner'], legal_hold: false, user_active: true, email: 'pat@gmail.com' })),
    };
    const inspector = {
      inspect: vi.fn(async () => ({ legal_hold: true, f_legal_hold: { tenant: true, document_artifacts: 0 }, retire_identity: false })),
    };
    const svc = new SignPrivacyExecutionService(
      requests as never,
      subjects as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      inspector as never,
      {} as never,
    );
    const out = await svc.execute('r-1');
    expect(inspector.inspect).toHaveBeenCalledTimes(1);
    expect(inspector.inspect).toHaveBeenCalledWith('u-1', 't-1', { scope: 'sign' });
    expect(out.status).toBe('held');
    expect(requests.recordEvent).toHaveBeenCalledWith('r-1', 'LEGAL_HOLD', expect.anything(), { reason: 'tenant_legal_hold', document_artifacts: 0 });
  });
});
