import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  VALIDATION_PASS_STATUSES,
  buildCustodyRefs,
  validateArtifactCustody,
  type ArtifactCustodyRef,
  type VersionedObjectReader,
} from '../app/custody/artifact-custody-validation.js';

// Retention and Purge directive (ebd41d99) W8 — custody validation of purged artifacts:
// PURGED (recorded version gone) and PURGE_WAITING_LOCK (queued purge waiting on Object
// Lock) pass; PURGE_INCOMPLETE (purged row whose version is still readable) fails; the
// evidence snapshot keeps being verified.

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const gone = Object.assign(new Error('NoSuchVersion'), { name: 'NoSuchVersion' });

function reader(objects: Record<string, string>): VersionedObjectReader {
  return {
    getVersion: async (key, version) => {
      const body = objects[`${key}#${version}`];
      if (body === undefined) throw gone;
      return Buffer.from(body);
    },
  };
}

function ref(over: Partial<ArtifactCustodyRef> = {}): ArtifactCustodyRef {
  return {
    kind: 'EXECUTED_DOCUMENT',
    artifact_id: randomUUID(),
    tenant_id: randomUUID(),
    envelope_id: randomUUID(),
    expected_sha256: sha('pdf'),
    custody_object_key: 'k',
    custody_version_id: 'v1',
    custody_sha256: sha('pdf'),
    ...over,
  };
}

describe('validateArtifactCustody — purge states', () => {
  it('PURGED when the purged row\'s recorded version is gone, or nothing was ever stored', async () => {
    const report = await validateArtifactCustody(
      [ref({ purged_at: new Date() }), ref({ purged_at: new Date(), custody_object_key: null, custody_version_id: null, custody_sha256: null })],
      reader({}),
    );
    expect(report.findings.map((f) => f.status)).toEqual(['PURGED', 'PURGED']);
    expect(report.failures).toBe(0);
    expect(report.ok).toBe(2);
    expect(report.by_status.PURGED).toBe(2);
    expect(report.by_status.MISSING_CUSTODY).toBe(0);
  });

  it('PURGE_INCOMPLETE (a failure) when the purged row\'s version is still readable', async () => {
    const report = await validateArtifactCustody([ref({ purged_at: new Date() })], reader({ 'k#v1': 'pdf' }));
    expect(report.findings[0]?.status).toBe('PURGE_INCOMPLETE');
    expect(report.failures).toBe(1);
  });

  it('FETCH_FAILED (not PURGED) when the purge check cannot read S3 for another reason', async () => {
    const denied = { getVersion: async () => { throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }); } };
    const report = await validateArtifactCustody([ref({ purged_at: new Date() })], denied);
    expect(report.findings[0]?.status).toBe('FETCH_FAILED');
    expect(report.failures).toBe(1);
  });

  it('PURGE_WAITING_LOCK passes when the artifact still verifies, and a mismatch still fails', async () => {
    const until = new Date('2033-10-30T00:00:00Z');
    const ok = await validateArtifactCustody([ref({ purge_waiting_until: until })], reader({ 'k#v1': 'pdf' }));
    expect(ok.findings[0]?.status).toBe('PURGE_WAITING_LOCK');
    expect(ok.findings[0]?.detail).toContain('2033-10-30');
    expect(ok.failures).toBe(0);
    const bad = await validateArtifactCustody([ref({ purge_waiting_until: until })], reader({ 'k#v1': 'tampered' }));
    expect(bad.findings[0]?.status).toBe('CONTENT_MISMATCH');
    expect(bad.failures).toBe(1);
  });

  it('a non-purged missing custody is still MISSING_CUSTODY', async () => {
    const report = await validateArtifactCustody([ref({ custody_object_key: null, custody_version_id: null, custody_sha256: null })], reader({}));
    expect(report.findings[0]?.status).toBe('MISSING_CUSTODY');
    expect(report.failures).toBe(1);
  });

  it('pass statuses are exactly OK, PURGED and PURGE_WAITING_LOCK', () => {
    expect([...VALIDATION_PASS_STATUSES].sort()).toEqual(['OK', 'PURGED', 'PURGE_WAITING_LOCK']);
  });
});

describe('buildCustodyRefs — purge fields', () => {
  it('carries purged_at per row and purge_waiting per envelope; evidence is never marked purged', async () => {
    const tenant_id = randomUUID();
    const purgedEnv = randomUUID();
    const waitingEnv = randomUUID();
    const execId = randomUUID();
    const certId = randomUUID();
    const waitCert = randomUUID();
    const purged_at = new Date();
    const until = new Date('2033-10-31T00:00:00Z');
    const refs = buildCustodyRefs({
      executed: [{ id: execId, tenant_id, envelope_id: purgedEnv, executed_sha256: sha('x'), custody_object_key: 'e', custody_version_id: 'ev', custody_sha256: sha('x'), purged_at }],
      certificates: [
        { id: certId, tenant_id, envelope_id: purgedEnv, certificate_sha256: sha('c'), custody_object_key: 'c', custody_version_id: 'cv', custody_sha256: sha('c'), purged_at },
        { id: waitCert, tenant_id, envelope_id: waitingEnv, certificate_sha256: sha('w'), custody_object_key: 'w', custody_version_id: 'wv', custody_sha256: sha('w'), purged_at: null },
      ],
      events: [
        { envelope_id: purgedEnv, payload: { artifact_id: certId, sha256: sha('c'), version_id: 'cv', evidence: { object_key: 'ev', version_id: 'evv', sha256: sha('evidence') } } },
      ],
      purge_waiting: new Map([[waitingEnv, until]]),
    });
    const byId = new Map(refs.map((r) => [r.artifact_id, r]));
    expect(byId.get(execId)?.purged_at).toBe(purged_at);
    expect(byId.get(certId)?.purged_at).toBe(purged_at);
    expect(byId.get(`${certId}:evidence`)?.purged_at).toBeUndefined();
    expect(byId.get(waitCert)?.purged_at).toBeUndefined();
    expect(byId.get(waitCert)?.purge_waiting_until).toBe(until);

    const report = await validateArtifactCustody(refs, reader({ 'ev#evv': 'evidence', 'w#wv': 'w' }));
    const status = new Map(report.findings.map((f) => [f.artifact_id, f.status]));
    expect(status.get(execId)).toBe('PURGED');
    expect(status.get(certId)).toBe('PURGED');
    expect(status.get(`${certId}:evidence`)).toBe('OK');
    expect(status.get(waitCert)).toBe('PURGE_WAITING_LOCK');
    expect(report.failures).toBe(0);
  });

  it('rows without purge fields behave as before', () => {
    const tenant_id = randomUUID();
    const refs = buildCustodyRefs({
      executed: [{ id: 'a', tenant_id, envelope_id: 'e', executed_sha256: sha('x'), custody_object_key: 'k', custody_version_id: 'v', custody_sha256: sha('x') }],
      certificates: [],
      events: [],
    });
    expect(refs[0]).not.toHaveProperty('purged_at');
    expect(refs[0]).not.toHaveProperty('purge_waiting_until');
  });
});
