import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONNECTOR_AUDIT_EVENTS, ConnectorAuditLog } from '../lib/observability/connector-audit.js';

// T8-CONNECTOR-A — audit reuses the structured logger and is secret-free (§26/§48).

describe('ConnectorAuditLog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits structured events with the event discriminator and no raw secret material', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const audit = new ConnectorAuditLog();
    audit.emit(CONNECTOR_AUDIT_EVENTS.EXECUTION_FAILED, {
      tenant_id: 't1',
      connection_id: 'c1',
      // even if a caller accidentally passes secret-like keys, they are redacted
      authorization: 'Bearer leak-me',
      client_secret: 'sh-leak',
      detail_code: 'CONNECTOR_EXECUTION_FAILED',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const emitted = String(spy.mock.calls[0]?.[0]);
    expect(emitted).toContain('connector.execution.failed');
    expect(emitted).toContain('CONNECTOR_EXECUTION_FAILED');
    expect(emitted).not.toContain('Bearer leak-me');
    expect(emitted).not.toContain('sh-leak');
    expect(emitted).toContain('[REDACTED]');
  });

  it('exposes exactly the 10 governed connector event names (no new persisted audit TYPE)', () => {
    expect(Object.values(CONNECTOR_AUDIT_EVENTS)).toHaveLength(10);
    expect(new Set(Object.values(CONNECTOR_AUDIT_EVENTS)).size).toBe(10);
  });
});
