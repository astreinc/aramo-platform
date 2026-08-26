import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  ZoomWebhookSecretResolver,
  ZOOM_WEBHOOK_SECRET_REF_ENV,
} from '../communications/zoom-webhook-secret.resolver';

// COMM-B6 — the app-level webhook signing secret is resolved from an opaque REF
// (ZOOM_WEBHOOK_SECRET_REF) through the Secrets Manager READ abstraction, kept
// memory-only, and is FAIL-CLOSED: an unset ref or a resolution failure yields
// null (the webhook then returns 503, dark-by-construction). The raw secret is
// never persisted, never returned by the API, never logged. Tests inject a fake
// SecretsManagerPort — no AWS.

const savedRef = process.env[ZOOM_WEBHOOK_SECRET_REF_ENV];

afterEach(() => {
  if (savedRef === undefined) delete process.env[ZOOM_WEBHOOK_SECRET_REF_ENV];
  else process.env[ZOOM_WEBHOOK_SECRET_REF_ENV] = savedRef;
});

describe('ZoomWebhookSecretResolver', () => {
  it('resolves the secret via the Secrets Manager read port when the ref is set', async () => {
    process.env[ZOOM_WEBHOOK_SECRET_REF_ENV] = 'arn:aws:secretsmanager:zoom-webhook';
    const getSecretValue = vi.fn().mockResolvedValue('the-signing-secret');
    const resolver = new ZoomWebhookSecretResolver({ getSecretValue });

    await expect(resolver.resolve()).resolves.toBe('the-signing-secret');
    expect(getSecretValue).toHaveBeenCalledWith('arn:aws:secretsmanager:zoom-webhook');
  });

  it('caches after first success (memory-only; no repeated SM reads)', async () => {
    process.env[ZOOM_WEBHOOK_SECRET_REF_ENV] = 'ref-1';
    const getSecretValue = vi.fn().mockResolvedValue('s');
    const resolver = new ZoomWebhookSecretResolver({ getSecretValue });
    await resolver.resolve();
    await resolver.resolve();
    expect(getSecretValue).toHaveBeenCalledTimes(1);
  });

  it('FAIL-CLOSED: returns null when the ref env is unset (dark by construction)', async () => {
    delete process.env[ZOOM_WEBHOOK_SECRET_REF_ENV];
    const getSecretValue = vi.fn();
    const resolver = new ZoomWebhookSecretResolver({ getSecretValue });
    await expect(resolver.resolve()).resolves.toBeNull();
    expect(getSecretValue).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: returns null when secret resolution throws', async () => {
    process.env[ZOOM_WEBHOOK_SECRET_REF_ENV] = 'ref-x';
    const getSecretValue = vi.fn().mockRejectedValue(new Error('SM unavailable'));
    const resolver = new ZoomWebhookSecretResolver({ getSecretValue });
    await expect(resolver.resolve()).resolves.toBeNull();
  });
});
