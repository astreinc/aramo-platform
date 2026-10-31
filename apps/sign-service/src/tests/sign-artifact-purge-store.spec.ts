import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signCertificateKey, signEvidenceKey, signExecutedKey, signSourceKey } from '../app/custody/sign-artifact-storage.config.js';

import { FakeSignS3, fakeStore } from './fixtures/fake-sign-s3.js';

// Retention and Purge directive (ebd41d99) W3/W4 — SignArtifactStore.purgeEnvelopeObjects:
// every version and delete marker of one envelope's source/executed/certificate objects is
// deleted by version id; evidence is never touched (LD-3); a version under an unexpired
// Object Lock is skipped and reported (R-16); no bypass header; idempotent; paginated.

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const NOW = new Date('2026-11-01T00:00:00Z');

function seedEnvelope(fake: FakeSignS3, tenant: string, envelope: string) {
  const doc = randomUUID();
  const keys = {
    source: signSourceKey(tenant, envelope, randomUUID()),
    executed: signExecutedKey(tenant, envelope, doc, SHA_A),
    certificate: signCertificateKey(tenant, envelope, SHA_B),
    evidence: signEvidenceKey(tenant, envelope, SHA_C),
  };
  fake.seed(keys.source, Buffer.from('source v1'));
  fake.seed(keys.source, Buffer.from('source v2'));
  fake.seed(keys.executed, Buffer.from('executed'));
  fake.seed(keys.certificate, Buffer.from('certificate'));
  fake.seed(keys.evidence, Buffer.from('{"evidence":true}'));
  return keys;
}

describe('SignArtifactStore.purgeEnvelopeObjects', () => {
  it('deletes every version and delete marker of the requested kinds, by version id, and keeps evidence', async () => {
    const fake = new FakeSignS3();
    fake.now = () => NOW;
    const tenant = randomUUID();
    const envelope = randomUUID();
    const keys = seedEnvelope(fake, tenant, envelope);
    await fakeStore(fake).deleteSource(keys.source); // leaves a delete marker on top

    const res = await fakeStore(fake).purgeEnvelopeObjects(tenant, envelope, { kinds: ['source', 'executed', 'certificate'], now: NOW });

    expect(res.locked).toEqual([]);
    expect(res.deleted).toHaveLength(5); // source v1 + v2 + marker, executed, certificate
    expect(fake.objects.has(keys.source)).toBe(false);
    expect(fake.objects.has(keys.executed)).toBe(false);
    expect(fake.objects.has(keys.certificate)).toBe(false);
    expect(fake.current(keys.evidence)?.body.toString()).toBe('{"evidence":true}');
    const deletes = fake.callsOf('DeleteObjectCommand').filter((c) => c['VersionId'] !== undefined);
    expect(deletes).toHaveLength(5);
    for (const d of deletes) {
      expect(d).not.toHaveProperty('BypassGovernanceRetention');
      expect(String(d['Key'])).not.toContain('/evidence/');
    }
    for (const l of fake.callsOf('ListObjectVersionsCommand')) expect(String(l['Prefix'])).not.toContain('evidence');
  });

  it('only lists the requested kinds', async () => {
    const fake = new FakeSignS3();
    const tenant = randomUUID();
    const envelope = randomUUID();
    const keys = seedEnvelope(fake, tenant, envelope);

    const res = await fakeStore(fake).purgeEnvelopeObjects(tenant, envelope, { kinds: ['executed'], now: NOW });

    expect(res.deleted.map((d) => d.key)).toEqual([keys.executed]);
    expect(fake.current(keys.source)).toBeDefined();
    expect(fake.current(keys.certificate)).toBeDefined();
  });

  it('skips a version under an unexpired Object Lock, reports it, and deletes it once the lock has expired', async () => {
    const fake = new FakeSignS3();
    fake.now = () => NOW;
    const tenant = randomUUID();
    const envelope = randomUUID();
    const retain_until = new Date('2033-10-30T00:00:00Z');
    const key = signExecutedKey(tenant, envelope, randomUUID(), SHA_A);
    const locked = fake.seed(key, Buffer.from('locked'), { retain_until });
    const cert = signCertificateKey(tenant, envelope, SHA_B);
    fake.seed(cert, Buffer.from('expired lock'), { retain_until: new Date('2026-10-01T00:00:00Z') });

    const first = await fakeStore(fake).purgeEnvelopeObjects(tenant, envelope, { kinds: ['executed', 'certificate'], now: NOW });
    expect(first.locked).toEqual([{ key, version_id: locked, retain_until }]);
    expect(first.deleted.map((d) => d.key)).toEqual([cert]);
    expect(fake.current(key)?.body.toString()).toBe('locked');
    expect(fake.callsOf('DeleteObjectCommand').some((d) => d['Key'] === key)).toBe(false);

    const later = new Date('2033-10-31T00:00:00Z');
    fake.now = () => later;
    const second = await fakeStore(fake).purgeEnvelopeObjects(tenant, envelope, { kinds: ['executed', 'certificate'], now: later });
    expect(second.locked).toEqual([]);
    expect(second.deleted).toEqual([{ key, version_id: locked }]);
    expect(fake.objects.has(key)).toBe(false);
  });

  it('is idempotent: a re-run after a partial failure converges and a final re-run deletes nothing', async () => {
    const fake = new FakeSignS3();
    const tenant = randomUUID();
    const envelope = randomUUID();
    seedEnvelope(fake, tenant, envelope);
    const store = fakeStore(fake);
    const all: Array<'source' | 'executed' | 'certificate'> = ['source', 'executed', 'certificate'];

    fake.failOn = { name: 'DeleteObjectCommand', error: Object.assign(new Error('SlowDown'), { name: 'SlowDown' }), times: 1 };
    await expect(store.purgeEnvelopeObjects(tenant, envelope, { kinds: all, now: NOW })).rejects.toThrow('SlowDown');

    const retry = await store.purgeEnvelopeObjects(tenant, envelope, { kinds: all, now: NOW });
    expect(retry.deleted).toHaveLength(4);
    expect(fake.versionsUnder(`tenants/${tenant}/envelopes/${envelope}/`).map((v) => v.key).every((k) => k.includes('/evidence/'))).toBe(true);

    const again = await store.purgeEnvelopeObjects(tenant, envelope, { kinds: all, now: NOW });
    expect(again).toEqual({ deleted: [], locked: [] });
  });

  it('follows ListObjectVersions pagination', async () => {
    const fake = new FakeSignS3();
    fake.listPageSize = 2;
    const tenant = randomUUID();
    const envelope = randomUUID();
    for (let i = 0; i < 5; i += 1) fake.seed(signExecutedKey(tenant, envelope, randomUUID(), SHA_A), Buffer.from(`doc ${i}`));

    const res = await fakeStore(fake).purgeEnvelopeObjects(tenant, envelope, { kinds: ['executed'], now: NOW });

    expect(res.deleted).toHaveLength(5);
    expect(fake.callsOf('ListObjectVersionsCommand').length).toBeGreaterThan(1);
    expect(fake.versionsUnder(`tenants/${tenant}/envelopes/${envelope}/executed/`)).toEqual([]);
  });

  it('never reaches another envelope or another tenant sharing a prefix', async () => {
    const fake = new FakeSignS3();
    const tenant = randomUUID();
    const envelope = randomUUID();
    const other = seedEnvelope(fake, tenant, randomUUID());
    const otherTenant = seedEnvelope(fake, randomUUID(), envelope);
    seedEnvelope(fake, tenant, envelope);

    await fakeStore(fake).purgeEnvelopeObjects(tenant, envelope, { kinds: ['source', 'executed', 'certificate'], now: NOW });

    for (const k of [other.source, other.executed, other.certificate, otherTenant.executed]) expect(fake.current(k)).toBeDefined();
  });

  it('refuses an unknown kind and invalid identifiers', async () => {
    const fake = new FakeSignS3();
    const store = fakeStore(fake);
    await expect(store.purgeEnvelopeObjects(randomUUID(), randomUUID(), { kinds: ['evidence' as never] })).rejects.toThrow('not a purgeable');
    await expect(store.purgeEnvelopeObjects('not-a-uuid', randomUUID(), { kinds: ['executed'] })).rejects.toThrow();
    expect(fake.callsOf('DeleteObjectCommand')).toEqual([]);
  });
});
