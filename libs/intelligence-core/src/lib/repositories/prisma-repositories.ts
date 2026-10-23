import { randomUUID } from 'node:crypto';

import { Prisma, type IntelligenceOutbox, type IntelligenceWebhookDelivery } from '../../../prisma/generated/client/client.js';
import { RETIRED_ASSERTION_STATUSES } from '../vocabulary.js';

import type {
  AssertionRepository,
  EntitledTenantRepository,
  ReadAuditRepository,
  TrustStateRepository,
  VerificationRequestRepository,
  WebhookDeliveryRepository,
  EvidenceArtifactRepository,
  ExternalTalentReferenceRepository,
  GoldenTalentRepository,
  IdentityConflictRepository,
  IntelligenceInboxRepository,
  IntelligenceOutboxRepository,
  IntelligenceQuarantineRepository,
  IntelligenceRepositories,
  MergeSplitEventRepository,
  ResolvedProfileFactRepository,
  ServiceClientRepository,
  SubjectIdentifierRepository,
} from './types.js';

// ATI-SEP-1 T1 — Prisma repositories over the `intelligence` schema. Each one is
// bound to a client that is EITHER the root IntelligencePrismaService (single
// statements) or an interactive-transaction client (IntelligenceUnitOfWork).

export type IntelligenceDb = Prisma.TransactionClient;

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export class PrismaGoldenTalentRepository implements GoldenTalentRepository {
  constructor(private readonly db: IntelligenceDb) {}
  create(data: Parameters<GoldenTalentRepository['create']>[0]) {
    return this.db.goldenTalent.create({
      data: { id: randomUUID(), resolution_status: data.resolution_status, access_state: data.access_state ?? 'ACTIVE' },
    });
  }
  findById(id: string) {
    return this.db.goldenTalent.findUnique({ where: { id } });
  }
  update(id: string, patch: Parameters<GoldenTalentRepository['update']>[1]) {
    return this.db.goldenTalent.update({ where: { id }, data: patch });
  }
  async listForReassessment(assessedBefore: Date, limit: number) {
    const rows = await this.db.goldenTalent.findMany({
      where: {
        resolution_status: { not: 'MERGED' },
        OR: [{ trust_state: { is: null } }, { trust_state: { is: { assessed_at: { lt: assessedBefore } } } }],
      },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}

export class PrismaSubjectIdentifierRepository implements SubjectIdentifierRepository {
  constructor(private readonly db: IntelligenceDb) {}
  findActiveVerified(keys: Parameters<SubjectIdentifierRepository['findActiveVerified']>[0]) {
    if (keys.length === 0) return Promise.resolve([]);
    return this.db.subjectIdentifier.findMany({
      where: {
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
        OR: keys.map((k) => ({ identifier_type: k.identifier_type, normalized_value: k.normalized_value })),
      },
      orderBy: { created_at: 'asc' },
    });
  }
  listBySubject(subjectId: string) {
    return this.db.subjectIdentifier.findMany({ where: { subject_id: subjectId }, orderBy: { created_at: 'asc' } });
  }
  listActiveByReference(referenceId: string) {
    return this.db.subjectIdentifier.findMany({
      where: { source_reference_id: referenceId, status: 'ACTIVE' },
      orderBy: { created_at: 'asc' },
    });
  }
  listActiveByKey(key: Parameters<SubjectIdentifierRepository['listActiveByKey']>[0]) {
    return this.db.subjectIdentifier.findMany({
      where: { status: 'ACTIVE', identifier_type: key.identifier_type, normalized_value: key.normalized_value },
      orderBy: { created_at: 'asc' },
    });
  }
  create(data: Parameters<SubjectIdentifierRepository['create']>[0]) {
    return this.db.subjectIdentifier.create({ data: { id: randomUUID(), ...data } });
  }
  update(id: string, patch: Parameters<SubjectIdentifierRepository['update']>[1]) {
    return this.db.subjectIdentifier.update({ where: { id }, data: patch });
  }
  async repoint(ids: string[], subjectId: string) {
    if (ids.length > 0) await this.db.subjectIdentifier.updateMany({ where: { id: { in: ids } }, data: { subject_id: subjectId } });
  }
}

export class PrismaExternalTalentReferenceRepository implements ExternalTalentReferenceRepository {
  constructor(private readonly db: IntelligenceDb) {}
  findByTuple(t: Parameters<ExternalTalentReferenceRepository['findByTuple']>[0]) {
    return this.db.externalTalentReference.findUnique({
      where: {
        source_system_id_source_tenant_id_external_talent_id: {
          source_system_id: t.source_system_id,
          source_tenant_id: t.source_tenant_id,
          external_talent_id: t.external_talent_id,
        },
      },
    });
  }
  findById(id: string) {
    return this.db.externalTalentReference.findUnique({ where: { id } });
  }
  create(data: Parameters<ExternalTalentReferenceRepository['create']>[0]) {
    return this.db.externalTalentReference.create({
      data: { id: randomUUID(), ...data, last_identity_snapshot: json(data.last_identity_snapshot) },
    });
  }
  update(id: string, patch: Parameters<ExternalTalentReferenceRepository['update']>[1]) {
    const { last_identity_snapshot, ...rest } = patch;
    return this.db.externalTalentReference.update({
      where: { id },
      data: { ...rest, ...(last_identity_snapshot !== undefined ? { last_identity_snapshot: json(last_identity_snapshot) } : {}) },
    });
  }
  listBySubject(subjectId: string) {
    return this.db.externalTalentReference.findMany({ where: { subject_id: subjectId }, orderBy: { linked_at: 'asc' } });
  }
  async repoint(ids: string[], subjectId: string) {
    if (ids.length > 0) {
      await this.db.externalTalentReference.updateMany({ where: { id: { in: ids } }, data: { subject_id: subjectId } });
    }
  }
}

export class PrismaAssertionRepository implements AssertionRepository {
  constructor(private readonly db: IntelligenceDb) {}
  create(data: Parameters<AssertionRepository['create']>[0]) {
    return this.db.assertion.create({ data: { id: randomUUID(), ...data, payload: json(data.payload) } });
  }
  findById(id: string) {
    return this.db.assertion.findUnique({ where: { id } });
  }
  listLiveByReference(referenceId: string) {
    return this.db.assertion.findMany({
      where: { source_reference_id: referenceId, current_status: { notIn: [...RETIRED_ASSERTION_STATUSES] } },
      orderBy: { created_at: 'asc' },
    });
  }
  listBySubject(subjectId: string) {
    return this.db.assertion.findMany({ where: { subject_id: subjectId }, orderBy: { created_at: 'asc' } });
  }
  async setStatus(id: string, status: Parameters<AssertionRepository['setStatus']>[1]) {
    await this.db.assertion.update({ where: { id }, data: { current_status: status } });
  }
  async repoint(ids: string[], subjectId: string) {
    if (ids.length > 0) await this.db.assertion.updateMany({ where: { id: { in: ids } }, data: { subject_id: subjectId } });
  }
  appendEvent(data: Parameters<AssertionRepository['appendEvent']>[0]) {
    const { details, ...rest } = data;
    return this.db.assertionEvent.create({
      data: { id: randomUUID(), ...rest, ...(details ? { details: json(details) } : {}) },
    });
  }
  listEvents(assertionId: string) {
    return this.db.assertionEvent.findMany({ where: { assertion_id: assertionId }, orderBy: { created_at: 'asc' } });
  }
  listEventsFor(assertionIds: string[]) {
    if (assertionIds.length === 0) return Promise.resolve([]);
    return this.db.assertionEvent.findMany({ where: { assertion_id: { in: assertionIds } }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] });
  }
  listLinksFor(assertionIds: string[]) {
    if (assertionIds.length === 0) return Promise.resolve([]);
    return this.db.assertionLink.findMany({
      where: { OR: [{ from_assertion_id: { in: assertionIds } }, { to_assertion_id: { in: assertionIds } }] },
      orderBy: { created_at: 'asc' },
    });
  }
  appendLink(data: Parameters<AssertionRepository['appendLink']>[0]) {
    return this.db.assertionLink.create({ data: { id: randomUUID(), ...data } });
  }
}

export class PrismaEvidenceArtifactRepository implements EvidenceArtifactRepository {
  constructor(private readonly db: IntelligenceDb) {}
  upsertPolicy(documentType: string, globallyShareable: boolean) {
    return this.db.documentTypePolicy.upsert({
      where: { document_type: documentType },
      create: { document_type: documentType, globally_shareable: globallyShareable },
      update: { globally_shareable: globallyShareable },
    });
  }
  findPolicy(documentType: string) {
    return this.db.documentTypePolicy.findUnique({ where: { document_type: documentType } });
  }
  create(data: Parameters<EvidenceArtifactRepository['create']>[0]) {
    return this.db.evidenceArtifact.create({ data: { id: randomUUID(), ...data } });
  }
  listBySubject(subjectId: string) {
    return this.db.evidenceArtifact.findMany({ where: { subject_id: subjectId }, orderBy: { created_at: 'asc' } });
  }
  listSupports(artifactIds: string[]) {
    if (artifactIds.length === 0) return Promise.resolve([]);
    return this.db.artifactSupport.findMany({ where: { artifact_id: { in: artifactIds } } });
  }
  addSupport(assertionId: string, artifactId: string) {
    return this.db.artifactSupport.create({ data: { assertion_id: assertionId, artifact_id: artifactId } });
  }
  async repoint(ids: string[], subjectId: string) {
    if (ids.length > 0) await this.db.evidenceArtifact.updateMany({ where: { id: { in: ids } }, data: { subject_id: subjectId } });
  }
}

export class PrismaResolvedProfileFactRepository implements ResolvedProfileFactRepository {
  constructor(private readonly db: IntelligenceDb) {}
  upsert(data: Parameters<ResolvedProfileFactRepository['upsert']>[0]) {
    const value = json(data.value);
    return this.db.resolvedProfileFact.upsert({
      where: { subject_id_fact_type_fact_key: { subject_id: data.subject_id, fact_type: data.fact_type, fact_key: data.fact_key } },
      create: { id: randomUUID(), ...data, value },
      update: { value, supporting_assertion_ids: data.supporting_assertion_ids, resolved_at: new Date() },
    });
  }
  listBySubject(subjectId: string) {
    return this.db.resolvedProfileFact.findMany({ where: { subject_id: subjectId } });
  }
  async deleteOne(subjectId: string, factType: string, factKey: string) {
    await this.db.resolvedProfileFact.deleteMany({ where: { subject_id: subjectId, fact_type: factType, fact_key: factKey } });
  }
  async deleteBySubject(subjectId: string) {
    const r = await this.db.resolvedProfileFact.deleteMany({ where: { subject_id: subjectId } });
    return r.count;
  }
}

export class PrismaIdentityConflictRepository implements IdentityConflictRepository {
  constructor(private readonly db: IntelligenceDb) {}
  create(data: Parameters<IdentityConflictRepository['create']>[0]) {
    return this.db.identityConflict.create({
      data: {
        id: randomUUID(),
        subject_id: data.subject_id,
        conflict_type: data.conflict_type,
        related_subject_ids: data.related_subject_ids ?? [],
        details: json(data.details),
      },
    });
  }
  listBySubject(subjectId: string, status?: Parameters<IdentityConflictRepository['listBySubject']>[1]) {
    return this.db.identityConflict.findMany({
      where: { subject_id: subjectId, ...(status ? { status } : {}) },
      orderBy: { created_at: 'asc' },
    });
  }
  resolve(id: string) {
    return this.db.identityConflict.update({ where: { id }, data: { status: 'RESOLVED', resolved_at: new Date() } });
  }
  async repoint(ids: string[], subjectId: string) {
    if (ids.length > 0) await this.db.identityConflict.updateMany({ where: { id: { in: ids } }, data: { subject_id: subjectId } });
  }
}

export class PrismaMergeSplitEventRepository implements MergeSplitEventRepository {
  constructor(private readonly db: IntelligenceDb) {}
  create(data: Parameters<MergeSplitEventRepository['create']>[0]) {
    return this.db.mergeSplitEvent.create({ data: { id: randomUUID(), ...data, moved: json(data.moved) } });
  }
  findById(id: string) {
    return this.db.mergeSplitEvent.findUnique({ where: { id } });
  }
  listBySubject(subjectId: string) {
    return this.db.mergeSplitEvent.findMany({
      where: { OR: [{ from_subject_id: subjectId }, { into_subject_id: subjectId }] },
      orderBy: { created_at: 'asc' },
    });
  }
}

export class PrismaIntelligenceInboxRepository implements IntelligenceInboxRepository {
  constructor(private readonly db: IntelligenceDb) {}
  find(eventId: string) {
    return this.db.intelligenceInbox.findUnique({ where: { event_id: eventId } });
  }
  create(data: Parameters<IntelligenceInboxRepository['create']>[0]) {
    return this.db.intelligenceInbox.create({ data: { ...data, response: json(data.response) } });
  }
}

export class PrismaIntelligenceQuarantineRepository implements IntelligenceQuarantineRepository {
  constructor(private readonly db: IntelligenceDb) {}
  create(data: Parameters<IntelligenceQuarantineRepository['create']>[0]) {
    return this.db.intelligenceQuarantine.create({ data: { id: randomUUID(), ...data, issues: json(data.issues) } });
  }
}

export class PrismaIntelligenceOutboxRepository implements IntelligenceOutboxRepository {
  constructor(private readonly db: IntelligenceDb) {}
  enqueue(data: Parameters<IntelligenceOutboxRepository['enqueue']>[0]) {
    return this.db.intelligenceOutbox.create({ data: { id: randomUUID(), ...data, payload: json(data.payload) } });
  }
  listPending(limit: number) {
    return this.db.intelligenceOutbox.findMany({
      where: { published_at: null, quarantined_at: null },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
  }
  claim(limit: number, now: Date, leaseMs: number) {
    const lease = new Date(now.getTime() + leaseMs);
    return this.db.$queryRaw<IntelligenceOutbox[]>(Prisma.sql`
      UPDATE "intelligence"."IntelligenceOutbox" SET "claimed_at" = ${now}, "lease_expires_at" = ${lease}
      WHERE "id" IN (
        SELECT "id" FROM "intelligence"."IntelligenceOutbox"
        WHERE "published_at" IS NULL AND "quarantined_at" IS NULL
          AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= ${now})
        ORDER BY "created_at" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`);
  }
  async markPublished(id: string, claimedAt: Date, at: Date) {
    const r = await this.db.intelligenceOutbox.updateMany({
      where: { id, claimed_at: claimedAt, published_at: null },
      data: { published_at: at, lease_expires_at: null, last_publish_error: null },
    });
    return r.count === 1;
  }
  async markRetry(id: string, claimedAt: Date, error: string, retryAt: Date) {
    const r = await this.db.intelligenceOutbox.updateMany({
      where: { id, claimed_at: claimedAt, published_at: null },
      data: { publish_attempts: { increment: 1 }, last_publish_error: error.slice(0, 500), lease_expires_at: retryAt },
    });
    return r.count === 1;
  }
  async quarantine(id: string, claimedAt: Date, error: string, at: Date) {
    const r = await this.db.intelligenceOutbox.updateMany({
      where: { id, claimed_at: claimedAt, published_at: null },
      data: { publish_attempts: { increment: 1 }, last_publish_error: error.slice(0, 500), quarantined_at: at, lease_expires_at: null },
    });
    return r.count === 1;
  }
}

export class PrismaWebhookDeliveryRepository implements WebhookDeliveryRepository {
  constructor(private readonly db: IntelligenceDb) {}
  async createMany(rows: Parameters<WebhookDeliveryRepository['createMany']>[0]) {
    if (rows.length === 0) return 0;
    const r = await this.db.intelligenceWebhookDelivery.createMany({
      data: rows.map((d) => ({ id: randomUUID(), ...d, payload: json(d.payload) })),
      skipDuplicates: true,
    });
    return r.count;
  }
  listByOutboxEvent(outboxEventId: string) {
    return this.db.intelligenceWebhookDelivery.findMany({ where: { outbox_event_id: outboxEventId }, orderBy: { created_at: 'asc' } });
  }
  claim(limit: number, now: Date, leaseMs: number) {
    const lease = new Date(now.getTime() + leaseMs);
    return this.db.$queryRaw<IntelligenceWebhookDelivery[]>(Prisma.sql`
      UPDATE "intelligence"."IntelligenceWebhookDelivery" SET "claimed_at" = ${now}, "lease_expires_at" = ${lease}
      WHERE "id" IN (
        SELECT "id" FROM "intelligence"."IntelligenceWebhookDelivery"
        WHERE "delivered_at" IS NULL AND "quarantined_at" IS NULL
          AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= ${now})
        ORDER BY "created_at" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`);
  }
  async markDelivered(id: string, claimedAt: Date, at: Date) {
    const r = await this.db.intelligenceWebhookDelivery.updateMany({
      where: { id, claimed_at: claimedAt, delivered_at: null },
      data: { delivered_at: at, lease_expires_at: null, last_error: null },
    });
    return r.count === 1;
  }
  async markRetry(id: string, claimedAt: Date, error: string, retryAt: Date) {
    const r = await this.db.intelligenceWebhookDelivery.updateMany({
      where: { id, claimed_at: claimedAt, delivered_at: null },
      data: { attempts: { increment: 1 }, last_error: error.slice(0, 500), lease_expires_at: retryAt },
    });
    return r.count === 1;
  }
  async quarantine(id: string, claimedAt: Date, error: string, at: Date) {
    const r = await this.db.intelligenceWebhookDelivery.updateMany({
      where: { id, claimed_at: claimedAt, delivered_at: null },
      data: { attempts: { increment: 1 }, last_error: error.slice(0, 500), quarantined_at: at, lease_expires_at: null },
    });
    return r.count === 1;
  }
}

export class PrismaVerificationRequestRepository implements VerificationRequestRepository {
  constructor(private readonly db: IntelligenceDb) {}
  create(data: Parameters<VerificationRequestRepository['create']>[0]) {
    return this.db.verificationRequest.create({ data });
  }
  findById(id: string) {
    return this.db.verificationRequest.findUnique({ where: { id } });
  }
  listPending(key: Parameters<VerificationRequestRepository['listPending']>[0], subjectId: string | null) {
    return this.db.verificationRequest.findMany({
      where: {
        status: 'PENDING',
        identifier_type: key.identifier_type,
        normalized_value: key.normalized_value,
        ...(subjectId !== null ? { subject_id: subjectId } : {}),
      },
      orderBy: { created_at: 'asc' },
    });
  }
  update(id: string, patch: Parameters<VerificationRequestRepository['update']>[1]) {
    return this.db.verificationRequest.update({ where: { id }, data: patch });
  }
}

export class PrismaTrustStateRepository implements TrustStateRepository {
  constructor(private readonly db: IntelligenceDb) {}
  find(subjectId: string) {
    return this.db.subjectTrustState.findUnique({ where: { subject_id: subjectId } });
  }
  upsert(subjectId: string, row: Parameters<TrustStateRepository['upsert']>[1], assessedAt: Date) {
    return this.db.subjectTrustState.upsert({
      where: { subject_id: subjectId },
      create: { subject_id: subjectId, ...row, assessed_at: assessedAt },
      update: { ...row, assessed_at: assessedAt },
    });
  }
}

export class PrismaEntitledTenantRepository implements EntitledTenantRepository {
  constructor(private readonly db: IntelligenceDb) {}
  find(sourceSystemId: string, tenantId: string) {
    return this.db.entitledTenant.findUnique({ where: { source_system_id_tenant_id: { source_system_id: sourceSystemId, tenant_id: tenantId } } });
  }
  upsert(sourceSystemId: string, tenantId: string, active: boolean) {
    return this.db.entitledTenant.upsert({
      where: { source_system_id_tenant_id: { source_system_id: sourceSystemId, tenant_id: tenantId } },
      create: { source_system_id: sourceSystemId, tenant_id: tenantId, active },
      update: { active },
    });
  }
  async deactivateAllExcept(sourceSystemId: string, keep: string[]) {
    const r = await this.db.entitledTenant.updateMany({
      where: { source_system_id: sourceSystemId, active: true, tenant_id: { notIn: keep } },
      data: { active: false },
    });
    return r.count;
  }
}

export class PrismaReadAuditRepository implements ReadAuditRepository {
  constructor(private readonly db: IntelligenceDb) {}
  create(data: Parameters<ReadAuditRepository['create']>[0]) {
    return this.db.intelligenceReadAudit.create({ data: { id: randomUUID(), ...data } });
  }
}

export class PrismaServiceClientRepository implements ServiceClientRepository {
  constructor(private readonly db: IntelligenceDb) {}
  find(clientId: string) {
    return this.db.serviceClient.findUnique({ where: { client_id: clientId } });
  }
  upsert(data: Parameters<ServiceClientRepository['upsert']>[0]) {
    const { client_id, ...rest } = data;
    return this.db.serviceClient.upsert({ where: { client_id }, create: data, update: rest });
  }
}

/** Bind every repository to one client (root or transaction). */
export function createPrismaRepositories(db: IntelligenceDb): IntelligenceRepositories {
  return {
    subjects: new PrismaGoldenTalentRepository(db),
    identifiers: new PrismaSubjectIdentifierRepository(db),
    references: new PrismaExternalTalentReferenceRepository(db),
    assertions: new PrismaAssertionRepository(db),
    artifacts: new PrismaEvidenceArtifactRepository(db),
    facts: new PrismaResolvedProfileFactRepository(db),
    conflicts: new PrismaIdentityConflictRepository(db),
    mergeSplit: new PrismaMergeSplitEventRepository(db),
    inbox: new PrismaIntelligenceInboxRepository(db),
    quarantine: new PrismaIntelligenceQuarantineRepository(db),
    outbox: new PrismaIntelligenceOutboxRepository(db),
    clients: new PrismaServiceClientRepository(db),
    verifications: new PrismaVerificationRequestRepository(db),
    trust: new PrismaTrustStateRepository(db),
    entitlements: new PrismaEntitledTenantRepository(db),
    readAudit: new PrismaReadAuditRepository(db),
    deliveries: new PrismaWebhookDeliveryRepository(db),
  };
}
