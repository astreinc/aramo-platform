import { randomBytes } from 'node:crypto';

import { SOURCE_SYSTEM_IDS, isIntelligenceScope, type IntelligenceScope } from '@aramo/intelligence-contracts';

import type { IntelligenceUnitOfWork } from '../repositories/types.js';

import { hashClientSecret } from './service-token.service.js';

// ATI-SEP-1 T4 — provision (create or rotate) a ServiceClient row. Used by the
// app's provision-service-client entry (tools/intelligence-service-client.sh).
// The secret is hashed with hashClientSecret (scrypt) and NEVER stored; when no
// secret is supplied a random one is generated and returned ONCE.

export class ServiceClientProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceClientProvisioningError';
  }
}

export interface ProvisionServiceClientInput {
  client_id: string;
  source_system_id: string;
  scopes: string[];
  /** Omitted → a random 48-byte secret is generated. */
  secret?: string;
  active?: boolean;
}

export interface ProvisionServiceClientResult {
  client_id: string;
  source_system_id: string;
  scopes: IntelligenceScope[];
  active: boolean;
  /** Present only when TI generated it — shown once, never stored. */
  generated_secret?: string;
}

const CLIENT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MIN_SECRET = 32;

export async function provisionServiceClient(uow: IntelligenceUnitOfWork, input: ProvisionServiceClientInput): Promise<ProvisionServiceClientResult> {
  if (!CLIENT_ID.test(input.client_id)) throw new ServiceClientProvisioningError('client_id must match [a-z0-9][a-z0-9._-]{1,63}');
  if (!(SOURCE_SYSTEM_IDS as readonly string[]).includes(input.source_system_id)) {
    throw new ServiceClientProvisioningError(`source_system_id must be one of ${SOURCE_SYSTEM_IDS.join(', ')}`);
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || !scopes.every(isIntelligenceScope)) throw new ServiceClientProvisioningError('scopes must be a non-empty subset of the intelligence scopes');
  if (input.secret !== undefined && input.secret.length < MIN_SECRET) {
    throw new ServiceClientProvisioningError(`a supplied secret must be at least ${MIN_SECRET} characters`);
  }
  const generated = input.secret === undefined ? randomBytes(48).toString('base64url') : undefined;
  const secret = input.secret ?? (generated as string);
  const active = input.active ?? true;
  await uow.run((repos) =>
    repos.clients.upsert({
      client_id: input.client_id,
      secret_hash: hashClientSecret(secret),
      allowed_scopes: scopes.sort(),
      source_system_id: input.source_system_id,
      active,
    }),
  );
  return {
    client_id: input.client_id,
    source_system_id: input.source_system_id,
    scopes: scopes as IntelligenceScope[],
    active,
    ...(generated !== undefined ? { generated_secret: generated } : {}),
  };
}
