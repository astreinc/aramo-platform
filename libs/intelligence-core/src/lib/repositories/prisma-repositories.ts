import { randomUUID } from 'node:crypto';

import type { Prisma } from '../../../prisma/generated/client/client.js';
import { RETIRED_ASSERTION_STATUSES } from '../vocabulary.js';

import type {
  AssertionRepository,
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
  };
}
