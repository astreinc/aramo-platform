import { describe, expect, it } from 'vitest';

import { ServiceClientProvisioningError, provisionServiceClient, verifyClientSecret } from '../index.js';

import { InMemoryIntelligence } from './support/in-memory-intelligence.js';

// ATI-SEP-1 T4 — ServiceClient provisioning (tools/intelligence-service-client.sh).

describe('provisionServiceClient', () => {
  it('creates a client with a generated secret (returned once, stored as a scrypt hash) and rotates it', async () => {
    const mem = new InMemoryIntelligence();
    const r = await provisionServiceClient(mem, { client_id: 'aramo-ats', source_system_id: 'ARAMO_ATS', scopes: ['intelligence:read', 'intelligence:ingest', 'intelligence:read'] });
    expect(r).toMatchObject({ client_id: 'aramo-ats', scopes: ['intelligence:ingest', 'intelligence:read'], active: true });
    const row = mem.state.clients.get('aramo-ats') as NonNullable<ReturnType<typeof mem.state.clients.get>>;
    expect(row.allowed_scopes).toEqual(['intelligence:ingest', 'intelligence:read']);
    expect(row.secret_hash.startsWith('scrypt$')).toBe(true);
    expect(row.secret_hash).not.toContain(r.generated_secret as string);
    expect(verifyClientSecret(r.generated_secret as string, row.secret_hash)).toBe(true);

    const rotated = await provisionServiceClient(mem, { client_id: 'aramo-ats', source_system_id: 'ARAMO_ATS', scopes: ['intelligence:verify'], secret: 'z'.repeat(40), active: false });
    expect(rotated.generated_secret).toBeUndefined();
    expect(mem.state.clients.get('aramo-ats')).toMatchObject({ allowed_scopes: ['intelligence:verify'], active: false });
    expect(verifyClientSecret('z'.repeat(40), mem.state.clients.get('aramo-ats')?.secret_hash as string)).toBe(true);
  });

  it.each([
    [{ client_id: 'Bad Id', source_system_id: 'ARAMO_ATS', scopes: ['intelligence:read'] }],
    [{ client_id: 'ok', source_system_id: 'OTHER', scopes: ['intelligence:read'] }],
    [{ client_id: 'ok', source_system_id: 'ARAMO_ATS', scopes: ['admin'] }],
    [{ client_id: 'ok', source_system_id: 'ARAMO_ATS', scopes: [] }],
    [{ client_id: 'ok', source_system_id: 'ARAMO_ATS', scopes: ['intelligence:read'], secret: 'short' }],
  ])('refuses %j', async (input) => {
    await expect(provisionServiceClient(new InMemoryIntelligence(), input)).rejects.toBeInstanceOf(ServiceClientProvisioningError);
  });
});
