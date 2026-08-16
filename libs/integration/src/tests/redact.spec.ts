import { describe, expect, it } from 'vitest';

import { REDACTED, redactForLog, redactString } from '../lib/observability/redact.js';

// T8-CONNECTOR-A — secret-safe logging (directive §25/§48).

describe('redactForLog', () => {
  it('redacts secret-like keys at any depth and never emits raw values', () => {
    const input = {
      provider_key: 'acme_vms',
      authorization: 'Bearer abc123',
      nested: { client_secret: 'sh-XXXX', api_key: 'k-YYYY', refresh_token: 'r-ZZZZ' },
      headers: { Authorization: 'Basic zzz', 'x-webhook-secret': 'wh-1' },
      password: 'p',
      credential: 'c',
    };
    const out = JSON.stringify(redactForLog(input));
    for (const raw of ['Bearer abc123', 'sh-XXXX', 'k-YYYY', 'r-ZZZZ', 'Basic zzz', 'wh-1']) {
      expect(out).not.toContain(raw);
    }
    expect(out).toContain(REDACTED);
    expect(out).toContain('acme_vms'); // non-secret metadata is preserved
  });

  it('bounds long strings so provider bodies are never dumped wholesale', () => {
    const long = 'x'.repeat(5000);
    expect(redactString(long).length).toBeLessThan(600);
    expect(redactString(long)).toContain('[truncated]');
  });

  it('redacts an Error to name+bounded message only', () => {
    const out = redactForLog(new Error('boom')) as { name: string; message: string };
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
  });
});
