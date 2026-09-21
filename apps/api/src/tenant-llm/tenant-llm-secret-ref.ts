// TENANT-LLM-1/2 §P2 — server-derived Secrets Manager id for a tenant's own key
// FOR A PROVIDER. Mirrors deriveConnectorSecretManagerId: env-scoped, tenant-
// namespaced, UUID-asserted, derived from the OWNED tenant_id + the wired
// provider — NEVER raw client input. This is the SAME id the ai-draft
// SecretCacheService resolves at call time, so a key written here is exactly
// what the tenant's LLM calls read (TENANT-LLM-2 generalizes the id from the
// Anthropic-only `.../anthropic-api-key` to `.../${provider}-api-key`).

import type { LlmProvider } from '@aramo/ai-draft';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Tombstone sentinel for clear-not-delete (mirrors the delegated-token store):
// clearing writes this value so the secret history is preserved and the reader
// treats it as "not configured".
export const TENANT_LLM_TOMBSTONE = '{"_tombstone":true}';

export function deriveTenantLlmSecretId(args: {
  readonly env: string;
  readonly tenant_id: string;
  readonly provider: LlmProvider;
}): string {
  if (args.env.length === 0) {
    throw new Error('ARAMO_ENV not set');
  }
  if (!UUID_RE.test(args.tenant_id)) {
    throw new Error('invalid tenant_id: expected uuid');
  }
  return `aramo/${args.env}/tenant-llm/${args.tenant_id}/${args.provider}-api-key`;
}

export function isTombstone(value: string): boolean {
  return value === TENANT_LLM_TOMBSTONE || value.length === 0;
}
