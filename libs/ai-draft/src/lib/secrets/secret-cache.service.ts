import { Injectable } from '@nestjs/common';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  ResourceNotFoundException,
  DecryptionFailure,
  InternalServiceError,
  InvalidParameterException,
  InvalidRequestException,
} from '@aws-sdk/client-secrets-manager';
import { AramoError } from '@aramo/common';

import type { LlmProvider } from '../providers/llm-provider.js';
import { PROVIDER_LOCAL_ENV_VAR } from '../providers/llm-provider.js';

import { LlmKeyNotConfiguredError } from './llm-key-not-configured.error.js';

// TENANT-LLM-1/2 — PER-TENANT, PER-PROVIDER BYO key custody (was platform-wide;
// TENANT-LLM-2 generalizes the one-provider custody to many providers).
//
// Each tenant brings its own key FOR ITS ACTIVE PROVIDER, stored under a
// tenant+provider-namespaced Secrets Manager id
// `aramo/${ARAMO_ENV}/tenant-llm/${tenant_id}/${provider}-api-key`
// (mirrors the connector/msgraph-delegated per-tenant custody). The key is
// resolved with the OWNED tenant_id of the work being processed + the resolved
// provider — never a client-supplied value. There is NO fallback across any
// trust boundary (directive LOCK): a tenant with no key for a provider resolves
// to LlmKeyNotConfiguredError, a terminal/fail-closed governed state — never a
// platform key, another provider's key, or another tenant's key.
//
// Cache: per (tenant, provider), process-lifetime (Nest singleton). Rotation
// invalidates the (tenant, provider) entry — the admin set/rotate/clear path
// calls invalidate(tenant_id, provider); automated TTL is a follow-on.
//
// LOCAL-DEV ONLY env fallback: on a developer box `ARAMO_ENV=local` a
// per-provider single key env-var (ANTHROPIC_API_KEY / OPENAI_API_KEY) may be
// set for convenience (one dev tenant). HARD-GATED to `local` — it is NEVER
// consulted in staging/prod, where the no-cross-tenant-fallback LOCK is absolute.

@Injectable()
export class SecretCacheService {
  private readonly cachedByTenantProvider = new Map<string, string>();
  private smClient: SecretsManagerClient | null = null;

  private cacheKey(tenantId: string, provider: LlmProvider): string {
    return `${tenantId}:${provider}`;
  }

  /**
   * Resolve THIS tenant's own key for the given provider. Server-derived
   * (tenant_id + provider), per (tenant, provider) cache, fail-closed to
   * LlmKeyNotConfiguredError with NO cross-boundary fallback.
   */
  async getProviderApiKey(tenantId: string, provider: LlmProvider): Promise<string> {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new AramoError('INTERNAL_ERROR', 'tenant_id required for LLM key resolution', 500, {
        requestId: 'ai-draft-secret-cache',
        details: { kind: 'tenant_id_missing' },
      });
    }

    const key = this.cacheKey(tenantId, provider);
    const cached = this.cachedByTenantProvider.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const env = process.env['ARAMO_ENV'];
    if (env === undefined || env.length === 0) {
      throw new AramoError('INTERNAL_ERROR', 'ARAMO_ENV not set', 500, {
        requestId: 'ai-draft-secret-cache',
        details: { kind: 'env_missing' },
      });
    }

    // LOCAL-DEV ONLY: a single-box per-provider developer convenience key.
    // HARD-GATED to `local` so it can never become a cross-tenant platform
    // fallback in a real multi-tenant environment (directive LOCK).
    if (env === 'local') {
      const envKey = process.env[PROVIDER_LOCAL_ENV_VAR[provider]];
      if (envKey !== undefined && envKey.length > 0) {
        this.cachedByTenantProvider.set(key, envKey);
        return envKey;
      }
    }

    const secretId = `aramo/${env}/tenant-llm/${tenantId}/${provider}-api-key`;
    const region = process.env['AWS_REGION'] ?? 'us-east-1';

    if (this.smClient === null) {
      this.smClient = new SecretsManagerClient({ region });
    }

    try {
      const response = await this.smClient.send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      if (response.SecretString === undefined || response.SecretString.length === 0) {
        // An empty secret is a not-configured state, not a 500 — the tenant must
        // (re)set a real key.
        throw new LlmKeyNotConfiguredError(tenantId);
      }
      this.cachedByTenantProvider.set(key, response.SecretString);
      return response.SecretString;
    } catch (err: unknown) {
      if (err instanceof LlmKeyNotConfiguredError) throw err;
      if (err instanceof AramoError) throw err;
      throw this.translateAwsError(err, secretId, tenantId);
    }
  }

  /**
   * Drop a tenant's cached key for a provider (called by the admin
   * set/rotate/clear path after a write, for rotation-correctness).
   */
  invalidate(tenantId: string, provider: LlmProvider): void {
    this.cachedByTenantProvider.delete(this.cacheKey(tenantId, provider));
  }

  private translateAwsError(err: unknown, secretId: string, tenantId: string): AramoError | LlmKeyNotConfiguredError {
    const message = err instanceof Error ? err.message : String(err);

    // The secret does not exist → the tenant has not configured a key. Terminal,
    // fail-closed governed state — NOT a platform fallback, NOT a 500.
    if (err instanceof ResourceNotFoundException) {
      return new LlmKeyNotConfiguredError(tenantId);
    }
    if (err instanceof DecryptionFailure) {
      return new AramoError('INTERNAL_ERROR', message, 500, {
        requestId: 'ai-draft-secret-cache',
        details: { kind: 'secret_decryption_failed', secretId },
      });
    }
    if (err instanceof InternalServiceError) {
      return new AramoError('INTERNAL_ERROR', message, 502, {
        requestId: 'ai-draft-secret-cache',
        details: { kind: 'aws_internal_error', secretId },
      });
    }
    if (
      err instanceof InvalidParameterException ||
      err instanceof InvalidRequestException
    ) {
      return new AramoError('INTERNAL_ERROR', message, 500, {
        requestId: 'ai-draft-secret-cache',
        details: { kind: 'secret_request_invalid', secretId },
      });
    }
    return new AramoError('INTERNAL_ERROR', message, 502, {
      requestId: 'ai-draft-secret-cache',
      details: { kind: 'aws_unknown_error', secretId },
    });
  }
}
