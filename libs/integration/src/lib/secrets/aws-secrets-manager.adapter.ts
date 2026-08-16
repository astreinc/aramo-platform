import { Injectable, Logger } from '@nestjs/common';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import type { SecretsManagerPort } from './secrets-manager.port.js';
import type { SecretsManagerWriterPort } from './secrets-manager-writer.port.js';

// T8-CONNECTOR-A — concrete AWS Secrets Manager adapter (directive §7). Mirrors
// the platform pattern in libs/ai-draft (lazy client, env-driven region). Handles
// BOTH the resolver read side and the write-only credential-set side. The secret
// id is always server-derived (see ConnectorSecretResolver / IntegrationConnectionService).
//
// NOTE: this adapter is NOT exercised against production in Connector-A. No
// production secret is created; connector schedules are not enabled in prod
// (directive §24/§51). Connector-A tests use in-memory fakes.
@Injectable()
export class AwsSecretsManagerAdapter implements SecretsManagerPort, SecretsManagerWriterPort {
  private readonly logger = new Logger('AwsSecretsManagerAdapter');
  private client: SecretsManagerClient | null = null;

  private sm(): SecretsManagerClient {
    if (this.client === null) {
      this.client = new SecretsManagerClient({
        region: process.env['AWS_REGION'] ?? 'us-east-1',
      });
    }
    return this.client;
  }

  async getSecretValue(secretId: string): Promise<string> {
    const res = await this.sm().send(new GetSecretValueCommand({ SecretId: secretId }));
    if (res.SecretString === undefined || res.SecretString.length === 0) {
      throw new Error('connector secret is empty or unset');
    }
    return res.SecretString;
  }

  async putSecretValue(secretId: string, value: string): Promise<void> {
    // Create-or-replace: PutSecretValue requires an existing secret, so create
    // on first set. The value NEVER touches Postgres, logs, or audit.
    try {
      await this.sm().send(
        new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        await this.sm().send(new CreateSecretCommand({ Name: secretId, SecretString: value }));
        return;
      }
      if (err instanceof ResourceExistsException) {
        await this.sm().send(
          new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
        );
        return;
      }
      throw err;
    }
  }
}
