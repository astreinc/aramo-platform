import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { backoffMs } from '../outbox-backoff.js';
import { TRUSTED_TIMESTAMP_PORT, type TrustedTimestampPort } from '../ports/trusted-timestamp.port.js';

// Feature-Parity Directive v1.0 §1.18 — RFC 3161 trusted timestamps for an envelope's
// executed documents and its evidence manifest. Called at completion; a TSA failure
// NEVER blocks or fails completion: the subject is recorded PENDING ("timestamp
// pending") and the retry worker requests it again with backoff until a verified token
// is granted. Off (every method a no-op) when no TSA adapter is bound.

export type TrustedTimestampSubjectKind = 'EXECUTED_DOCUMENT' | 'EVIDENCE_MANIFEST';
export type TrustedTimestampStatus = 'PENDING' | 'GRANTED';

export interface TrustedTimestampView {
  subject_kind: TrustedTimestampSubjectKind;
  envelope_document_id: string | null;
  message_imprint_sha256: string;
  hash_algorithm: string;
  status: TrustedTimestampStatus;
  gen_time: string | null;
  tsa_name: string | null;
  tsa_url: string;
  serial_number: string | null;
  policy_oid: string | null;
  tsa_certificate_sha256: string | null;
  // The DER TimeStampToken, base64 (standard alphabet), once granted.
  token_der_base64: string | null;
  // EVIDENCE_MANIFEST only: the exact manifest JSON whose SHA-256 was time-stamped.
  subject_canonical: string | null;
}

interface SubjectInput {
  subject_kind: TrustedTimestampSubjectKind;
  envelope_document_id: string | null;
  sha256: string;
  subject_canonical: string | null;
}

type Row = {
  id: string;
  subject_kind: string;
  envelope_document_id: string | null;
  message_imprint_sha256: string;
  hash_algorithm: string;
  subject_canonical: string | null;
  status: string;
  tsa_url: string;
  token_der: Uint8Array | null;
  gen_time: Date | null;
  serial_number: string | null;
  policy_oid: string | null;
  tsa_name: string | null;
  tsa_certificate_sha256: string | null;
  attempt_count: number;
  next_attempt_at: Date | null;
};

// A claimed retry holds the row for this long before another worker may take it.
const CLAIM_LEASE_MS = 120_000;
const MAX_ERROR_LENGTH = 300;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

function toView(r: Row): TrustedTimestampView {
  return {
    subject_kind: r.subject_kind as TrustedTimestampSubjectKind,
    envelope_document_id: r.envelope_document_id,
    message_imprint_sha256: r.message_imprint_sha256,
    hash_algorithm: r.hash_algorithm,
    status: r.status as TrustedTimestampStatus,
    gen_time: r.gen_time ? r.gen_time.toISOString() : null,
    tsa_name: r.tsa_name,
    tsa_url: r.tsa_url,
    serial_number: r.serial_number,
    policy_oid: r.policy_oid,
    tsa_certificate_sha256: r.tsa_certificate_sha256,
    token_der_base64: r.token_der ? Buffer.from(r.token_der).toString('base64') : null,
    subject_canonical: r.subject_canonical,
  };
}

// The executed-document ordering the certificate and evidence use: documents first (in
// the given ordinal order), then the manifest.
function sortViews(views: TrustedTimestampView[], documentOrder: string[] = []): TrustedTimestampView[] {
  const position = (v: TrustedTimestampView): number => {
    if (v.subject_kind === 'EVIDENCE_MANIFEST') return Number.MAX_SAFE_INTEGER;
    const i = v.envelope_document_id === null ? -1 : documentOrder.indexOf(v.envelope_document_id);
    return i === -1 ? Number.MAX_SAFE_INTEGER - 1 : i;
  };
  return [...views].sort((a, b) => position(a) - position(b));
}

@Injectable()
export class TrustedTimestampService {
  private readonly logger = new Logger('TrustedTimestampService');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(TRUSTED_TIMESTAMP_PORT) private readonly tsa?: TrustedTimestampPort | null,
  ) {}

  /** True when a TSA adapter is bound (SIGN_TSA_URL set and the feature AVAILABLE). */
  get enabled(): boolean {
    return this.tsa !== undefined && this.tsa !== null;
  }

  /**
   * Time-stamp each executed document's SHA-256 (one attempt each, in parallel). Never
   * throws. Returns every document's timestamp state for the certificate.
   */
  async stampExecutedDocuments(
    tenant_id: string,
    envelope_id: string,
    documents: ReadonlyArray<{ envelope_document_id: string; executed_sha256: string }>,
  ): Promise<TrustedTimestampView[]> {
    if (!this.enabled) return [];
    const views = await Promise.all(
      documents.map((d) =>
        this.stampSubject(tenant_id, envelope_id, {
          subject_kind: 'EXECUTED_DOCUMENT',
          envelope_document_id: d.envelope_document_id,
          sha256: d.executed_sha256,
          subject_canonical: null,
        }),
      ),
    );
    return sortViews(views.filter((v): v is TrustedTimestampView => v !== null), documents.map((d) => d.envelope_document_id));
  }

  /**
   * Time-stamp the evidence manifest as completed: the SHA-256 of its canonical JSON,
   * which is kept on the row. Never throws; the first recorded manifest wins.
   */
  async stampEvidenceManifest(tenant_id: string, envelope_id: string, canonicalManifestJson: string): Promise<TrustedTimestampView | null> {
    if (!this.enabled) return null;
    const sha256 = createHash('sha256').update(Buffer.from(canonicalManifestJson, 'utf8')).digest('hex');
    return this.stampSubject(tenant_id, envelope_id, {
      subject_kind: 'EVIDENCE_MANIFEST',
      envelope_document_id: null,
      sha256,
      subject_canonical: canonicalManifestJson,
    });
  }

  /** Every recorded timestamp of an envelope (granted or pending), documents first. */
  async listForEnvelope(tenant_id: string, envelope_id: string, documentOrder: string[] = []): Promise<TrustedTimestampView[]> {
    const rows = (await this.prisma.signTrustedTimestamp.findMany({ where: { tenant_id, envelope_id } })) as Row[];
    return sortViews(rows.map(toView), documentOrder);
  }

  /**
   * The retry job: re-request every PENDING timestamp whose backoff has elapsed. Each
   * row is claimed (compare-and-set on next_attempt_at) so concurrent workers never
   * request the same subject twice at once. Returns how many were granted.
   */
  async retryDue(now: Date = new Date(), limit = 25): Promise<number> {
    if (!this.enabled) return 0;
    const due = (await this.prisma.signTrustedTimestamp.findMany({
      where: { status: 'PENDING', OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }] },
      orderBy: [{ next_attempt_at: 'asc' }, { created_at: 'asc' }],
      take: limit,
    })) as Row[];
    let granted = 0;
    for (const row of due) {
      const claimed = await this.prisma.signTrustedTimestamp.updateMany({
        where: { id: row.id, status: 'PENDING', next_attempt_at: row.next_attempt_at },
        data: { next_attempt_at: new Date(now.getTime() + CLAIM_LEASE_MS) },
      });
      if (claimed.count !== 1) continue;
      const view = await this.attempt(row);
      if (view.status === 'GRANTED') granted += 1;
    }
    return granted;
  }

  private async stampSubject(tenant_id: string, envelope_id: string, subject: SubjectInput): Promise<TrustedTimestampView | null> {
    try {
      const row = await this.findOrCreate(tenant_id, envelope_id, subject);
      if (row.status === 'GRANTED') return toView(row);
      return await this.attempt(row);
    } catch (err) {
      // Completion must never fail on a timestamp: the row (if any) stays PENDING.
      this.logger.warn(`trusted timestamp not recorded for envelope ${envelope_id} (${subject.subject_kind}): ${(err as Error).message}`);
      return null;
    }
  }

  private async findOrCreate(tenant_id: string, envelope_id: string, subject: SubjectInput): Promise<Row> {
    const find = async (): Promise<Row | null> =>
      (await this.prisma.signTrustedTimestamp.findFirst({
        where: { tenant_id, envelope_id, subject_kind: subject.subject_kind, envelope_document_id: subject.envelope_document_id },
      })) as Row | null;
    const existing = await find();
    if (existing !== null) return existing;
    try {
      return (await this.prisma.signTrustedTimestamp.create({
        data: {
          id: randomUUID(),
          tenant_id,
          envelope_id,
          subject_kind: subject.subject_kind,
          envelope_document_id: subject.envelope_document_id,
          message_imprint_sha256: subject.sha256,
          subject_canonical: subject.subject_canonical,
          status: 'PENDING',
          tsa_url: (this.tsa as TrustedTimestampPort).tsa_url,
        },
      })) as Row;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const raced = await find();
      if (raced === null) throw e;
      return raced;
    }
  }

  // One TSA request for a PENDING row. Success → GRANTED (only from PENDING); failure →
  // attempt recorded, next attempt after the backoff. Never throws on a TSA failure.
  private async attempt(row: Row): Promise<TrustedTimestampView> {
    const tsa = this.tsa as TrustedTimestampPort;
    try {
      const token = await tsa.timestamp(row.message_imprint_sha256);
      if (token.message_imprint_sha256 !== row.message_imprint_sha256) throw new Error('TSA token imprint does not match the subject');
      const now = new Date();
      const updated = await this.prisma.signTrustedTimestamp.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'GRANTED',
          token_der: Buffer.from(token.token_der),
          gen_time: token.gen_time,
          serial_number: token.serial_number,
          policy_oid: token.policy_oid,
          tsa_name: token.tsa_name,
          tsa_certificate_sha256: token.tsa_certificate_sha256,
          tsa_url: tsa.tsa_url,
          attempt_count: row.attempt_count + 1,
          next_attempt_at: null,
          last_error: null,
          granted_at: now,
        },
      });
      const fresh = (await this.prisma.signTrustedTimestamp.findUnique({ where: { id: row.id } })) as Row | null;
      if (updated.count !== 1 && fresh === null) throw new Error('timestamp row disappeared');
      return toView(fresh ?? row);
    } catch (err) {
      const attempts = row.attempt_count + 1;
      const message = ((err as Error).message ?? 'unknown error').slice(0, MAX_ERROR_LENGTH);
      this.logger.warn(`trusted timestamp pending (attempt ${attempts}) for ${row.subject_kind} ${row.id}: ${message}`);
      await this.prisma.signTrustedTimestamp
        .updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { attempt_count: attempts, next_attempt_at: new Date(Date.now() + backoffMs(attempts)), last_error: message },
        })
        .catch(() => undefined);
      return toView({ ...row, attempt_count: attempts });
    }
  }
}
