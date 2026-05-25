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

// M5 PR-5 §4.7 — AWS Secrets Manager adapter for the Anthropic API key.
// Per ADR-0015 Decision 4: secrets live in AWS Secrets Manager, fetched
// lazily on first use and cached in-process for the lifetime of the
// NestJS singleton. The secret id template is
// `aramo/${ARAMO_ENV}/anthropic-api-key`.
//
// Ruling 4 (cache-shape): instance-level cachedApiKey field; since
// SecretCacheService is a Nest singleton (default scope), this caches
// for process lifetime. Rotation is a process restart — automated
// rotation lands at M7 IaC.

@Injectable()
export class SecretCacheService {
  private cachedApiKey: string | null = null;
  private smClient: SecretsManagerClient | null = null;

  async getAnthropicApiKey(): Promise<string> {
    if (this.cachedApiKey !== null) {
      return this.cachedApiKey;
    }

    const env = process.env['ARAMO_ENV'];
    if (env === undefined || env.length === 0) {
      throw new AramoError('INTERNAL_ERROR', 'ARAMO_ENV not set', 500, {
        requestId: 'ai-draft-secret-cache',
        details: { kind: 'env_missing' },
      });
    }

    const secretId = `aramo/${env}/anthropic-api-key`;
    const region = process.env['AWS_REGION'] ?? 'us-east-1';

    if (this.smClient === null) {
      this.smClient = new SecretsManagerClient({ region });
    }

    try {
      const response = await this.smClient.send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      if (response.SecretString === undefined || response.SecretString.length === 0) {
        throw new AramoError(
          'INTERNAL_ERROR',
          `secret value empty: ${secretId}`,
          500,
          {
            requestId: 'ai-draft-secret-cache',
            details: { kind: 'secret_value_empty', secretId },
          },
        );
      }
      this.cachedApiKey = response.SecretString;
      return this.cachedApiKey;
    } catch (err: unknown) {
      if (err instanceof AramoError) throw err;
      throw this.translateAwsError(err, secretId);
    }
  }

  private translateAwsError(err: unknown, secretId: string): AramoError {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof ResourceNotFoundException) {
      return new AramoError('INTERNAL_ERROR', `secret missing: ${secretId}`, 500, {
        requestId: 'ai-draft-secret-cache',
        details: { kind: 'secret_not_found', secretId },
      });
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
