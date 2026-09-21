import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { SecretCacheService } from '@aramo/ai-draft';
import {
  SECRETS_MANAGER_PORT,
  SECRETS_MANAGER_WRITER,
  type SecretsManagerPort,
  type SecretsManagerWriterPort,
} from '@aramo/integration';

import {
  TENANT_LLM_TOMBSTONE,
  deriveTenantLlmSecretId,
  isTombstone,
} from './tenant-llm-secret-ref.js';

// TENANT-LLM-1 §P2 — the tenant admin write path for the per-tenant Anthropic key.
//
// WRITE-ONLY: the key is stored in Secrets Manager and is NEVER read back,
// returned, or logged. set/rotate write the value; clear writes a tombstone
// (not-delete, mirroring the delegated-token store); status returns a has-key
// BOOLEAN only. Every write invalidates the ai-draft per-tenant cache immediately
// so a rotation takes effect at once. The secret id is server-derived from the
// OWNED tenant_id (never client input). Audit events carry actor + tenant +
// action — NEVER the value.

export interface TenantLlmKeyStatus {
  readonly provider: 'anthropic';
  readonly configured: boolean;
}

@Injectable()
export class TenantLlmKeyService {
  constructor(
    @Inject(SECRETS_MANAGER_WRITER) private readonly writer: SecretsManagerWriterPort,
    @Inject(SECRETS_MANAGER_PORT) private readonly reader: SecretsManagerPort,
    private readonly secretCache: SecretCacheService,
    @Inject('TenantLlmKeyLogger') private readonly logger: AramoLogger,
  ) {}

  private secretId(tenantId: string): string {
    const env = process.env['ARAMO_ENV'] ?? '';
    return deriveTenantLlmSecretId({ env, tenant_id: tenantId });
  }

  /** Set or rotate the tenant's Anthropic key (write-only). */
  async setKey(args: { tenant_id: string; actor_id: string; api_key: string; requestId: string }): Promise<void> {
    const key = args.api_key.trim();
    if (key.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'api_key must be a non-empty string', 400, {
        requestId: args.requestId,
        details: { field: 'api_key' },
      });
    }
    await this.writer.putSecretValue(this.secretId(args.tenant_id), key);
    this.secretCache.invalidate(args.tenant_id);
    // Audit — actor + tenant + action ONLY (never the key, never its length).
    this.logger.log({
      event: 'tenant_llm.key_set',
      tenant_id: args.tenant_id,
      actor_id: args.actor_id,
      provider: 'anthropic',
    });
  }

  /** Clear the tenant's key (tombstone-not-delete). */
  async clearKey(args: { tenant_id: string; actor_id: string }): Promise<void> {
    await this.writer.putSecretValue(this.secretId(args.tenant_id), TENANT_LLM_TOMBSTONE);
    this.secretCache.invalidate(args.tenant_id);
    this.logger.log({
      event: 'tenant_llm.key_cleared',
      tenant_id: args.tenant_id,
      actor_id: args.actor_id,
      provider: 'anthropic',
    });
  }

  /** Has-key boolean ONLY — never reads the key back to the caller. */
  async status(tenant_id: string): Promise<TenantLlmKeyStatus> {
    let configured = false;
    try {
      const value = await this.reader.getSecretValue(this.secretId(tenant_id));
      configured = !isTombstone(value);
    } catch {
      // Absent secret (ResourceNotFound) → not configured. The value is never
      // surfaced; only the boolean.
      configured = false;
    }
    return { provider: 'anthropic', configured };
  }
}
