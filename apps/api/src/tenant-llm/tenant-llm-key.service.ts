import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { SecretCacheService, WIRED_LLM_PROVIDERS, type LlmProvider } from '@aramo/ai-draft';
import { TenantSettingService, type LlmActiveProvider } from '@aramo/settings';
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

// TENANT-LLM-1/2 §P2 — the tenant admin write path for per-tenant, PER-PROVIDER
// BYO LLM keys + the active-provider selection.
//
// WRITE-ONLY: a key is stored in Secrets Manager and is NEVER read back,
// returned, or logged. set/rotate write the value; clear writes a tombstone
// (not-delete, mirroring the delegated-token store); status returns a has-key
// BOOLEAN only. Every write invalidates the ai-draft per-(tenant,provider) cache
// immediately so a rotation takes effect at once. The secret id is server-derived
// from the OWNED tenant_id + the wired provider (never client input). Audit events
// carry actor + tenant + provider + action — NEVER the value.
//
// Active provider (TENANT-LLM-2) is the `llm.active_provider` KnownSetting,
// server-owned + validated against the WIRED set (§4.5 no-dead-knobs). Selecting
// a provider does NOT delete other providers' stored keys and does NOT require
// that provider's key to be present.

export interface TenantLlmKeyStatus {
  readonly provider: LlmProvider;
  readonly configured: boolean;
}

export interface TenantLlmOverview {
  readonly active_provider: LlmProvider;
  readonly providers: ReadonlyArray<TenantLlmKeyStatus>;
}

@Injectable()
export class TenantLlmKeyService {
  constructor(
    @Inject(SECRETS_MANAGER_WRITER) private readonly writer: SecretsManagerWriterPort,
    @Inject(SECRETS_MANAGER_PORT) private readonly reader: SecretsManagerPort,
    private readonly secretCache: SecretCacheService,
    private readonly settings: TenantSettingService,
    @Inject('TenantLlmKeyLogger') private readonly logger: AramoLogger,
  ) {}

  private secretId(tenantId: string, provider: LlmProvider): string {
    const env = process.env['ARAMO_ENV'] ?? '';
    return deriveTenantLlmSecretId({ env, tenant_id: tenantId, provider });
  }

  /** Set or rotate the tenant's key for a provider (write-only). */
  async setKey(args: {
    tenant_id: string;
    actor_id: string;
    provider: LlmProvider;
    api_key: string;
    requestId: string;
  }): Promise<void> {
    const key = args.api_key.trim();
    if (key.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'api_key must be a non-empty string', 400, {
        requestId: args.requestId,
        details: { field: 'api_key' },
      });
    }
    await this.writer.putSecretValue(this.secretId(args.tenant_id, args.provider), key);
    this.secretCache.invalidate(args.tenant_id, args.provider);
    // Audit — actor + tenant + provider + action ONLY (never the key/length).
    this.logger.log({
      event: 'tenant_llm.key_set',
      tenant_id: args.tenant_id,
      actor_id: args.actor_id,
      provider: args.provider,
    });
  }

  /** Clear the tenant's key for a provider (tombstone-not-delete). */
  async clearKey(args: { tenant_id: string; actor_id: string; provider: LlmProvider }): Promise<void> {
    await this.writer.putSecretValue(this.secretId(args.tenant_id, args.provider), TENANT_LLM_TOMBSTONE);
    this.secretCache.invalidate(args.tenant_id, args.provider);
    this.logger.log({
      event: 'tenant_llm.key_cleared',
      tenant_id: args.tenant_id,
      actor_id: args.actor_id,
      provider: args.provider,
    });
  }

  /** Has-key boolean ONLY for a provider — never reads the key back to the caller. */
  async status(tenant_id: string, provider: LlmProvider): Promise<TenantLlmKeyStatus> {
    let configured = false;
    try {
      const value = await this.reader.getSecretValue(this.secretId(tenant_id, provider));
      configured = !isTombstone(value);
    } catch {
      // Absent secret (ResourceNotFound) → not configured. The value is never
      // surfaced; only the boolean.
      configured = false;
    }
    return { provider, configured };
  }

  /** The tenant's active provider (server-owned KnownSetting; default anthropic). */
  async getActiveProvider(tenant_id: string): Promise<LlmProvider> {
    // SettingValueOf<'llm.active_provider'> is LlmActiveProvider, structurally
    // identical to ai-draft's LlmProvider (both the wired 'anthropic'|'openai').
    const active: LlmActiveProvider = await this.settings.get(tenant_id, 'llm.active_provider');
    return active;
  }

  /**
   * Select the tenant's active provider. The value is validated against the
   * wired set by the setting's validator (VALIDATION_ERROR for an unwired
   * provider — §4.5 no-dead-knobs); the setting store is the single source.
   */
  async setActiveProvider(args: {
    tenant_id: string;
    actor_id: string;
    provider: LlmActiveProvider;
    requestId: string;
  }): Promise<void> {
    await this.settings.set(
      args.tenant_id,
      'llm.active_provider',
      args.provider,
      args.actor_id,
      args.requestId,
    );
    this.logger.log({
      event: 'tenant_llm.active_provider_set',
      tenant_id: args.tenant_id,
      actor_id: args.actor_id,
      provider: args.provider,
    });
  }

  /** The full LLM overview: active provider + per-wired-provider has-key status. */
  async overview(tenant_id: string): Promise<TenantLlmOverview> {
    const [active_provider, providers] = await Promise.all([
      this.getActiveProvider(tenant_id),
      Promise.all(WIRED_LLM_PROVIDERS.map((p) => this.status(tenant_id, p))),
    ]);
    return { active_provider, providers };
  }
}
