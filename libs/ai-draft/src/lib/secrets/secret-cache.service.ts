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

import { LlmKeyNotConfiguredError } from './llm-key-not-configured.error.js';

// TENANT-LLM-1 — PER-TENANT Anthropic key custody (was platform-wide).
//
// Each tenant brings its own Anthropic key, stored under a tenant-namespaced
// Secrets Manager id `aramo/${ARAMO_ENV}/tenant-llm/${tenant_id}/anthropic-api-key`
// (mirrors the connector/msgraph-delegated per-tenant custody). The key is
// resolved with the OWNED tenant_id of the work being processed — never a
// client-supplied value. There is NO platform-key fallback across tenants
// (directive LOCK): a tenant with no key resolves to LlmKeyNotConfiguredError,
// a terminal/fail-closed governed state.
//
// Cache: per-tenant, process-lifetime (Nest singleton). Rotation invalidates the
// tenant's entry (invalidate(tenant_id)) — the admin set/rotate/clear path calls
// it; automated TTL is a follow-on.
//
// LOCAL-DEV ONLY env fallback: on a developer box `ARAMO_ENV=local` may set a
// single `ANTHROPIC_API_KEY` for convenience (one dev tenant). This fallback is
// HARD-GATED to `local` — it is NEVER consulted in staging/prod, where the
// no-cross-tenant-fallback LOCK is absolute.

@Injectable()
export class SecretCacheService {
  private readonly cachedByTenant = new Map<string, string>();
  private smClient: SecretsManagerClient | null = null;

  async getAnthropicApiKey(tenantId: string): Promise<string> {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new AramoError('INTERNAL_ERROR', 'tenant_id required for LLM key resolution', 500, {
        requestId: 'ai-draft-secret-cache',
        details: { kind: 'tenant_id_missing' },
      });
    }

    const cached = this.cachedByTenant.get(tenantId);
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

    // LOCAL-DEV ONLY: a single-box developer convenience key. HARD-GATED to
    // `local` so it can never become a cross-tenant platform fallback in a
    // real multi-tenant environment (directive LOCK).
    if (env === 'local') {
      const envKey = process.env['ANTHROPIC_API_KEY'];
      if (envKey !== undefined && envKey.length > 0) {
        this.cachedByTenant.set(tenantId, envKey);
        return envKey;
      }
    }

    const secretId = `aramo/${env}/tenant-llm/${tenantId}/anthropic-api-key`;
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
      this.cachedByTenant.set(tenantId, response.SecretString);
      return response.SecretString;
    } catch (err: unknown) {
      if (err instanceof LlmKeyNotConfiguredError) throw err;
      if (err instanceof AramoError) throw err;
      throw this.translateAwsError(err, secretId, tenantId);
    }
  }

  /** Drop a tenant's cached key (called by the admin set/rotate/clear path). */
  invalidate(tenantId: string): void {
    this.cachedByTenant.delete(tenantId);
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
