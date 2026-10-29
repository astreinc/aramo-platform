// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 — the
// dedicated Sign artifact bucket configuration. Independent of the platform document
// bucket (S3_RESUME_BUCKET) and of the box-wide AWS_* key: sign-service reads its own
// SIGN_ARTIFACT_* settings, so the credential switch to the Sign-only principal is a
// change of these values alone (recon gate R-2).
//
//   SIGN_ARTIFACT_BUCKET                 bucket name. Unset/empty = DARK: no Sign bucket,
//                                        OWNED sources stay in the platform bucket and
//                                        no custody upload or reconcile runs.
//   SIGN_ARTIFACT_AWS_ACCESS_KEY_ID      optional explicit key pair (both or neither);
//   SIGN_ARTIFACT_AWS_SECRET_ACCESS_KEY  unset = the AWS SDK default credential chain.
//   SIGN_ARTIFACT_RETENTION_DAYS         LC-1: NO default. Unset/empty = no Object Lock
//                                        retention is applied. When set it must be a
//                                        positive integer (else sign-service refuses to
//                                        boot). The mode is always GOVERNANCE.
//   SIGN_ARTIFACT_S3_ENDPOINT            optional (LocalStack); implies path-style URLs.
//   SIGN_ARTIFACT_AWS_REGION             optional; default AWS_REGION, then us-east-1.

export const SIGN_ARTIFACT_RETENTION_MODE = 'GOVERNANCE' as const;
// Upper bound on the configured period (100 years) so a typo cannot produce an
// unrepresentable retain-until date. Not a default: nothing is applied when unset.
export const SIGN_ARTIFACT_RETENTION_MAX_DAYS = 36_500;

export interface SignArtifactStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string | null;
  readonly forcePathStyle: boolean;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | null;
  /** null = no retention applied (LC-1). */
  readonly retentionDays: number | null;
}

export class SignArtifactConfigError extends Error {
  constructor(message: string) {
    super(`sign artifact storage: ${message}`);
    this.name = 'SignArtifactConfigError';
  }
}

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** LC-1 — unset/empty => null (no retention); otherwise a positive integer or a refusal. */
export function parseRetentionDays(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new SignArtifactConfigError(`SIGN_ARTIFACT_RETENTION_DAYS must be a positive integer number of days (got "${raw}")`);
  }
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days > SIGN_ARTIFACT_RETENTION_MAX_DAYS) {
    throw new SignArtifactConfigError(`SIGN_ARTIFACT_RETENTION_DAYS must be at most ${SIGN_ARTIFACT_RETENTION_MAX_DAYS} (got "${raw}")`);
  }
  return days;
}

/**
 * Reads the Sign artifact storage settings. Returns null when the feature is dark
 * (SIGN_ARTIFACT_BUCKET unset). Throws SignArtifactConfigError on an invalid setting —
 * validated even while dark, so a bad value is caught before the bucket is enabled.
 */
export function loadSignArtifactStorageConfig(env: NodeJS.ProcessEnv): SignArtifactStorageConfig | null {
  const retentionDays = parseRetentionDays(value(env, 'SIGN_ARTIFACT_RETENTION_DAYS'));
  const accessKeyId = value(env, 'SIGN_ARTIFACT_AWS_ACCESS_KEY_ID');
  const secretAccessKey = value(env, 'SIGN_ARTIFACT_AWS_SECRET_ACCESS_KEY');
  if ((accessKeyId === null) !== (secretAccessKey === null)) {
    throw new SignArtifactConfigError('SIGN_ARTIFACT_AWS_ACCESS_KEY_ID and SIGN_ARTIFACT_AWS_SECRET_ACCESS_KEY must be set together');
  }
  const bucket = value(env, 'SIGN_ARTIFACT_BUCKET');
  if (bucket === null) return null;
  const endpoint = value(env, 'SIGN_ARTIFACT_S3_ENDPOINT');
  return {
    bucket,
    region: value(env, 'SIGN_ARTIFACT_AWS_REGION') ?? value(env, 'AWS_REGION') ?? 'us-east-1',
    endpoint,
    forcePathStyle: endpoint !== null,
    credentials: accessKeyId !== null && secretAccessKey !== null ? { accessKeyId, secretAccessKey } : null,
    retentionDays,
  };
}

// ── Key layout (SX-2 item 4, tenant first) ──

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertUuid(name: string, v: string): void {
  if (!UUID.test(v)) throw new Error(`sign artifact key: ${name} must be a UUID`);
}
function assertSha(v: string): void {
  if (!SHA256_HEX.test(v)) throw new Error('sign artifact key: sha256 must be 64 lowercase hex characters');
}

export const SIGN_ARTIFACT_KEY_ROOT = 'tenants/';

function envelopePrefix(tenant_id: string, envelope_id: string): string {
  assertUuid('tenant_id', tenant_id);
  assertUuid('envelope_id', envelope_id);
  return `${SIGN_ARTIFACT_KEY_ROOT}${tenant_id}/envelopes/${envelope_id}`;
}

export function signSourceKey(tenant_id: string, envelope_id: string, object_id: string): string {
  assertUuid('object_id', object_id);
  return `${envelopePrefix(tenant_id, envelope_id)}/source/${object_id}`;
}

export function signExecutedKey(tenant_id: string, envelope_id: string, envelope_document_id: string, sha256: string): string {
  assertUuid('envelope_document_id', envelope_document_id);
  assertSha(sha256);
  return `${envelopePrefix(tenant_id, envelope_id)}/executed/${envelope_document_id}/${sha256}.pdf`;
}

export function signCertificateKey(tenant_id: string, envelope_id: string, sha256: string): string {
  assertSha(sha256);
  return `${envelopePrefix(tenant_id, envelope_id)}/certificate/${sha256}.pdf`;
}

export function signEvidenceKey(tenant_id: string, envelope_id: string, sha256: string): string {
  assertSha(sha256);
  return `${envelopePrefix(tenant_id, envelope_id)}/evidence/${sha256}.json`;
}

const SOURCE_KEY = /^tenants\/[0-9a-f-]{36}\/envelopes\/[0-9a-f-]{36}\/source\/[0-9a-f-]{36}$/i;

/** True only for a source object key in the Sign bucket layout (the only deletable kind). */
export function isSignSourceKey(key: string): boolean {
  return SOURCE_KEY.test(key);
}

/** True for any key in the Sign bucket layout (reads route to the Sign bucket). */
export function isSignBucketKey(key: string): boolean {
  return key.startsWith(SIGN_ARTIFACT_KEY_ROOT);
}
