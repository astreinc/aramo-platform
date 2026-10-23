import { randomUUID } from 'node:crypto';

import type {
  Assertion,
  AssertionEvent,
  AssertionLink,
  ArtifactSupport,
  DocumentTypePolicy,
  EntitledTenant,
  EvidenceArtifact,
  ExternalTalentReference,
  GoldenTalent,
  IdentityConflict,
  IntelligenceInbox,
  IntelligenceOutbox,
  IntelligenceQuarantine,
  IntelligenceReadAudit,
  IntelligenceRepositories,
  IntelligenceWebhookDelivery,
  IntelligenceUnitOfWork,
  MergeSplitEvent,
  ResolvedProfileFact,
  ServiceClient,
  SubjectIdentifier,
  SubjectTrustState,
  UnitOfWorkOptions,
  VerificationRequest,
} from '../../index.js';
import { RETIRED_ASSERTION_STATUSES } from '../../index.js';

// In-memory IntelligenceRepositories + unit of work for UNIT specs. Mirrors the
// database rules the domain relies on: the VERIFIED+ACTIVE partial unique index,
// the reference tuple unique key, Assertion immutability (only current_status,
// and subject_id under repoint), and all-or-nothing units of work (state is
// restored when `fn` throws).

interface State {
  subjects: Map<string, GoldenTalent>;
  identifiers: Map<string, SubjectIdentifier>;
  references: Map<string, ExternalTalentReference>;
  assertions: Map<string, Assertion>;
  events: AssertionEvent[];
  links: AssertionLink[];
  artifacts: Map<string, EvidenceArtifact>;
  policies: Map<string, DocumentTypePolicy>;
  supports: ArtifactSupport[];
  facts: Map<string, ResolvedProfileFact>;
  conflicts: Map<string, IdentityConflict>;
  mergeSplit: MergeSplitEvent[];
  inbox: Map<string, IntelligenceInbox>;
  quarantine: IntelligenceQuarantine[];
  outbox: IntelligenceOutbox[];
  clients: Map<string, ServiceClient>;
  verifications: Map<string, VerificationRequest>;
  trust: Map<string, SubjectTrustState>;
  entitlements: Map<string, EntitledTenant>;
  readAudit: IntelligenceReadAudit[];
  deliveries: IntelligenceWebhookDelivery[];
}

function emptyState(): State {
  return {
    subjects: new Map(),
    identifiers: new Map(),
    references: new Map(),
    assertions: new Map(),
    events: [],
    links: [],
    artifacts: new Map(),
    policies: new Map(),
    supports: [],
    facts: new Map(),
    conflicts: new Map(),
    mergeSplit: [],
    inbox: new Map(),
    quarantine: [],
    outbox: [],
    clients: new Map(),
    verifications: new Map(),
    trust: new Map(),
    entitlements: new Map(),
    readAudit: [],
    deliveries: [],
  };
}

let clock = Date.parse('2026-10-23T00:00:00.000Z');
const tick = () => new Date((clock += 1000));
const claimable = (r: { claimed_at: Date | null; lease_expires_at: Date | null }, now: Date) =>
  r.lease_expires_at === null || r.lease_expires_at.getTime() <= now.getTime();
const owns = (r: { claimed_at: Date | null }, claimedAt: Date) => r.claimed_at !== null && r.claimed_at.getTime() === claimedAt.getTime();

export class InMemoryIntelligence implements IntelligenceUnitOfWork {
  state: State = emptyState();
  private repointEnabled = false;

  async run<T>(fn: (repos: IntelligenceRepositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const saved = structuredClone(this.state);
    this.repointEnabled = options.repoint === true;
    try {
      return await fn(this.repos());
    } catch (err) {
      this.state = saved;
      throw err;
    } finally {
      this.repointEnabled = false;
    }
  }

  private checkVerifiedUnique(row: SubjectIdentifier): void {
    if (row.verification_status !== 'VERIFIED' || row.status !== 'ACTIVE') return;
    for (const other of this.state.identifiers.values()) {
      if (
        other.id !== row.id &&
        other.verification_status === 'VERIFIED' &&
        other.status === 'ACTIVE' &&
        other.identifier_type === row.identifier_type &&
        other.normalized_value === row.normalized_value
      ) {
        throw new Error('unique violation: SubjectIdentifier_verified_active_unique');
      }
    }
  }

  repos(): IntelligenceRepositories {
    const s = () => this.state;
    const checkUnique = (row: SubjectIdentifier) => this.checkVerifiedUnique(row);
    const repointOn = () => this.repointEnabled;
    return {
      subjects: {
        async create(data) {
          const now = tick();
          const row: GoldenTalent = {
            id: randomUUID(),
            resolution_status: data.resolution_status,
            merged_into_id: null,
            access_state: data.access_state ?? 'ACTIVE',
            created_at: now,
            updated_at: now,
          };
          s().subjects.set(row.id, row);
          return { ...row };
        },
        async findById(id) {
          const r = s().subjects.get(id);
          return r ? { ...r } : null;
        },
        async update(id, patch) {
          const r = s().subjects.get(id);
          if (!r) throw new Error('not found');
          const next = { ...r, ...patch, updated_at: tick() } as GoldenTalent;
          if ((next.resolution_status === 'MERGED') !== (next.merged_into_id !== null)) throw new Error('check violation: merged_into');
          s().subjects.set(id, next);
          return { ...next };
        },
        async listForReassessment(before, limit) {
          return [...s().subjects.values()]
            .filter((g) => g.resolution_status !== 'MERGED')
            .filter((g) => {
              const t = s().trust.get(g.id);
              return t === undefined || t.assessed_at.getTime() < before.getTime();
            })
            .slice(0, limit)
            .map((g) => g.id);
        },
      },
      identifiers: {
        async findActiveVerified(keys) {
          return [...s().identifiers.values()]
            .filter(
              (r) =>
                r.status === 'ACTIVE' &&
                r.verification_status === 'VERIFIED' &&
                keys.some((k) => k.identifier_type === r.identifier_type && k.normalized_value === r.normalized_value),
            )
            .map((r) => ({ ...r }));
        },
        async listBySubject(subjectId) {
          return [...s().identifiers.values()].filter((r) => r.subject_id === subjectId).map((r) => ({ ...r }));
        },
        async listActiveByReference(referenceId) {
          return [...s().identifiers.values()]
            .filter((r) => r.source_reference_id === referenceId && r.status === 'ACTIVE')
            .map((r) => ({ ...r }));
        },
        async listActiveByKey(key) {
          return [...s().identifiers.values()]
            .filter((r) => r.status === 'ACTIVE' && r.identifier_type === key.identifier_type && r.normalized_value === key.normalized_value)
            .map((r) => ({ ...r }));
        },
        async create(data) {
          const row: SubjectIdentifier = {
            id: randomUUID(),
            subject_id: data.subject_id,
            identifier_type: data.identifier_type,
            normalized_value: data.normalized_value,
            jurisdiction: data.jurisdiction ?? null,
            identifier_class: data.identifier_class ?? null,
            verification_status: data.verification_status,
            verification_method: data.verification_method ?? null,
            verification_source: data.verification_source ?? null,
            verified_at: data.verified_at ?? null,
            valid_from: data.valid_from ?? null,
            valid_to: null,
            status: 'ACTIVE',
            is_primary: data.is_primary,
            source_reference_id: data.source_reference_id ?? null,
            created_at: tick(),
          };
          checkUnique(row);
          s().identifiers.set(row.id, row);
          return { ...row };
        },
        async update(id, patch) {
          const r = s().identifiers.get(id);
          if (!r) throw new Error('not found');
          const next = { ...r, ...patch } as SubjectIdentifier;
          checkUnique(next);
          s().identifiers.set(id, next);
          return { ...next };
        },
        async repoint(ids, subjectId) {
          for (const id of ids) {
            const r = s().identifiers.get(id);
            if (r) s().identifiers.set(id, { ...r, subject_id: subjectId });
          }
        },
      },
      references: {
        async findByTuple(t) {
          const r = [...s().references.values()].find(
            (x) =>
              x.source_system_id === t.source_system_id &&
              x.source_tenant_id === t.source_tenant_id &&
              x.external_talent_id === t.external_talent_id,
          );
          return r ? { ...r } : null;
        },
        async findById(id) {
          const r = s().references.get(id);
          return r ? { ...r } : null;
        },
        async create(data) {
          if (await this.findByTuple(data)) throw new Error('unique violation: reference tuple');
          const row: ExternalTalentReference = {
            id: randomUUID(),
            subject_id: data.subject_id,
            source_system_id: data.source_system_id,
            source_tenant_id: data.source_tenant_id,
            external_talent_id: data.external_talent_id,
            status: 'ACTIVE',
            linked_at: tick(),
            erased_at: null,
            last_identity_snapshot: structuredClone(data.last_identity_snapshot),
          };
          s().references.set(row.id, row);
          return { ...row };
        },
        async update(id, patch) {
          const r = s().references.get(id);
          if (!r) throw new Error('not found');
          const next = { ...r, ...patch } as ExternalTalentReference;
          s().references.set(id, next);
          return { ...next };
        },
        async listBySubject(subjectId) {
          return [...s().references.values()].filter((r) => r.subject_id === subjectId).map((r) => ({ ...r }));
        },
        async repoint(ids, subjectId) {
          for (const id of ids) {
            const r = s().references.get(id);
            if (r) s().references.set(id, { ...r, subject_id: subjectId });
          }
        },
      },
      assertions: {
        async create(data) {
          const row: Assertion = {
            id: randomUUID(),
            ...data,
            payload: structuredClone(data.payload),
            current_status: 'VALID',
            created_at: tick(),
          } as Assertion;
          s().assertions.set(row.id, row);
          return { ...row };
        },
        async findById(id) {
          const r = s().assertions.get(id);
          return r ? { ...r } : null;
        },
        async listLiveByReference(referenceId) {
          return [...s().assertions.values()]
            .filter(
              (a) =>
                a.source_reference_id === referenceId &&
                !(RETIRED_ASSERTION_STATUSES as readonly string[]).includes(a.current_status),
            )
            .map((a) => ({ ...a }));
        },
        async listBySubject(subjectId) {
          return [...s().assertions.values()].filter((a) => a.subject_id === subjectId).map((a) => ({ ...a }));
        },
        async setStatus(id, status) {
          const r = s().assertions.get(id);
          if (!r) throw new Error('not found');
          s().assertions.set(id, { ...r, current_status: status });
        },
        async repoint(ids, subjectId) {
          if (ids.length > 0 && !repointOn()) throw new Error('Assertion subject_id changes only through a merge or split');
          for (const id of ids) {
            const r = s().assertions.get(id);
            if (r) s().assertions.set(id, { ...r, subject_id: subjectId });
          }
        },
        async appendEvent(data) {
          const row: AssertionEvent = {
            id: randomUUID(),
            assertion_id: data.assertion_id,
            event_type: data.event_type,
            from_status: data.from_status ?? null,
            to_status: data.to_status ?? null,
            actor: data.actor,
            source_event_id: data.source_event_id ?? null,
            details: (data.details ?? null) as AssertionEvent['details'],
            created_at: tick(),
          };
          s().events.push(row);
          return { ...row };
        },
        async listEvents(assertionId) {
          return s().events.filter((e) => e.assertion_id === assertionId).map((e) => ({ ...e }));
        },
        async listEventsFor(ids) {
          const set = new Set(ids);
          return s().events.filter((e) => set.has(e.assertion_id)).map((e) => ({ ...e }));
        },
        async listLinksFor(ids) {
          const set = new Set(ids);
          return s().links.filter((l) => set.has(l.from_assertion_id) || set.has(l.to_assertion_id)).map((l) => ({ ...l }));
        },
        async appendLink(data) {
          if (s().links.some((l) => l.from_assertion_id === data.from_assertion_id && l.to_assertion_id === data.to_assertion_id && l.link_type === data.link_type)) {
            throw new Error('unique violation: AssertionLink');
          }
          const row: AssertionLink = { id: randomUUID(), ...data, created_at: tick() };
          s().links.push(row);
          return { ...row };
        },
      },
      artifacts: {
        async upsertPolicy(documentType, globallyShareable) {
          const row: DocumentTypePolicy = { document_type: documentType, globally_shareable: globallyShareable, updated_at: tick() };
          s().policies.set(documentType, row);
          return { ...row };
        },
        async findPolicy(documentType) {
          const r = s().policies.get(documentType);
          return r ? { ...r } : null;
        },
        async create(data) {
          if (!s().policies.has(data.document_type)) throw new Error('fk violation: DocumentTypePolicy');
          const row: EvidenceArtifact = {
            id: randomUUID(),
            subject_id: data.subject_id,
            document_type: data.document_type,
            issuer: data.issuer ?? null,
            storage_key: data.storage_key,
            sha256: data.sha256,
            retrieved_at: data.retrieved_at,
            source_url: data.source_url ?? null,
            created_at: tick(),
          };
          s().artifacts.set(row.id, row);
          return { ...row };
        },
        async listBySubject(subjectId) {
          return [...s().artifacts.values()].filter((a) => a.subject_id === subjectId).map((a) => ({ ...a }));
        },
        async listSupports(artifactIds) {
          const set = new Set(artifactIds);
          return s().supports.filter((x) => set.has(x.artifact_id)).map((x) => ({ ...x }));
        },
        async addSupport(assertionId, artifactId) {
          const row: ArtifactSupport = { assertion_id: assertionId, artifact_id: artifactId, created_at: tick() };
          s().supports.push(row);
          return { ...row };
        },
        async repoint(ids, subjectId) {
          for (const id of ids) {
            const r = s().artifacts.get(id);
            if (r) s().artifacts.set(id, { ...r, subject_id: subjectId });
          }
        },
      },
      facts: {
        async upsert(data) {
          const key = `${data.subject_id}|${data.fact_type}|${data.fact_key}`;
          const prior = s().facts.get(key);
          const row = {
            id: prior?.id ?? randomUUID(),
            ...data,
            resolved_at: tick(),
          } as ResolvedProfileFact;
          s().facts.set(key, row);
          return { ...row };
        },
        async listBySubject(subjectId) {
          return [...s().facts.values()].filter((f) => f.subject_id === subjectId).map((f) => ({ ...f }));
        },
        async deleteOne(subjectId, factType, factKey) {
          s().facts.delete(`${subjectId}|${factType}|${factKey}`);
        },
        async deleteBySubject(subjectId) {
          let n = 0;
          for (const [k, f] of s().facts) {
            if (f.subject_id === subjectId) {
              s().facts.delete(k);
              n++;
            }
          }
          return n;
        },
      },
      conflicts: {
        async create(data) {
          const row: IdentityConflict = {
            id: randomUUID(),
            subject_id: data.subject_id,
            conflict_type: data.conflict_type,
            related_subject_ids: data.related_subject_ids ?? [],
            details: structuredClone(data.details),
            status: 'OPEN',
            created_at: tick(),
            resolved_at: null,
          };
          s().conflicts.set(row.id, row);
          return { ...row };
        },
        async listBySubject(subjectId, status) {
          return [...s().conflicts.values()]
            .filter((c) => c.subject_id === subjectId && (status === undefined || c.status === status))
            .map((c) => ({ ...c }));
        },
        async resolve(id) {
          const r = s().conflicts.get(id);
          if (!r) throw new Error('not found');
          const next = { ...r, status: 'RESOLVED', resolved_at: tick() };
          s().conflicts.set(id, next);
          return { ...next };
        },
        async repoint(ids, subjectId) {
          for (const id of ids) {
            const r = s().conflicts.get(id);
            if (r) s().conflicts.set(id, { ...r, subject_id: subjectId });
          }
        },
      },
      mergeSplit: {
        async create(data) {
          if (data.from_subject_id === data.into_subject_id) throw new Error('check violation: distinct subjects');
          const row: MergeSplitEvent = { id: randomUUID(), ...data, moved: structuredClone(data.moved), created_at: tick() };
          s().mergeSplit.push(row);
          return { ...row };
        },
        async findById(id) {
          const r = s().mergeSplit.find((e) => e.id === id);
          return r ? { ...r } : null;
        },
        async listBySubject(subjectId) {
          return s().mergeSplit.filter((e) => e.from_subject_id === subjectId || e.into_subject_id === subjectId);
        },
      },
      inbox: {
        async find(eventId) {
          const r = s().inbox.get(eventId);
          return r ? { ...r } : null;
        },
        async create(data) {
          if (s().inbox.has(data.event_id)) throw new Error('unique violation: inbox');
          const row: IntelligenceInbox = { ...data, response: structuredClone(data.response), received_at: tick() };
          s().inbox.set(row.event_id, row);
          return { ...row };
        },
      },
      quarantine: {
        async create(data) {
          const row: IntelligenceQuarantine = {
            id: randomUUID(),
            source_system_id: data.source_system_id ?? null,
            source_event_id: data.source_event_id ?? null,
            client_id: data.client_id ?? null,
            reason: data.reason,
            issues: structuredClone(data.issues) as IntelligenceQuarantine['issues'],
            received_at: tick(),
          };
          s().quarantine.push(row);
          return { ...row };
        },
      },
      outbox: {
        async enqueue(data) {
          const row: IntelligenceOutbox = {
            id: randomUUID(),
            event_type: data.event_type,
            event_version: 'v1',
            tenant_id: data.tenant_id ?? null,
            source: 'talent-intelligence',
            subject_type: data.subject_type ?? 'golden_talent',
            subject_id: data.subject_id,
            payload: structuredClone(data.payload),
            occurred_at: data.occurred_at,
            correlation_id: data.correlation_id ?? null,
            causation_id: data.causation_id ?? null,
            created_at: tick(),
            claimed_at: null,
            lease_expires_at: null,
            publish_attempts: 0,
            last_publish_error: null,
            published_at: null,
            quarantined_at: null,
          };
          s().outbox.push(row);
          return { ...row };
        },
        async listPending(limit) {
          return s().outbox.filter((o) => o.published_at === null && o.quarantined_at === null).slice(0, limit);
        },
        async claim(limit, now, leaseMs) {
          const rows = s()
            .outbox.filter((o) => o.published_at === null && o.quarantined_at === null && claimable(o, now))
            .slice(0, limit);
          for (const r of rows) {
            r.claimed_at = new Date(now.getTime());
            r.lease_expires_at = new Date(now.getTime() + leaseMs);
          }
          return rows.map((r) => ({ ...r }));
        },
        async markPublished(id, claimedAt, at) {
          const r = s().outbox.find((o) => o.id === id);
          if (!r || r.published_at !== null || !owns(r, claimedAt)) return false;
          Object.assign(r, { published_at: at, lease_expires_at: null, last_publish_error: null });
          return true;
        },
        async markRetry(id, claimedAt, error, retryAt) {
          const r = s().outbox.find((o) => o.id === id);
          if (!r || r.published_at !== null || !owns(r, claimedAt)) return false;
          Object.assign(r, { publish_attempts: r.publish_attempts + 1, last_publish_error: error, lease_expires_at: retryAt });
          return true;
        },
        async quarantine(id, claimedAt, error, at) {
          const r = s().outbox.find((o) => o.id === id);
          if (!r || r.published_at !== null || !owns(r, claimedAt)) return false;
          Object.assign(r, { publish_attempts: r.publish_attempts + 1, last_publish_error: error, quarantined_at: at, lease_expires_at: null });
          return true;
        },
      },
      deliveries: {
        async createMany(rows) {
          let n = 0;
          for (const d of rows) {
            if (s().deliveries.some((x) => x.outbox_event_id === d.outbox_event_id && x.reference_id === d.reference_id)) continue;
            s().deliveries.push({
              id: randomUUID(),
              ...d,
              payload: structuredClone(d.payload),
              created_at: tick(),
              claimed_at: null,
              lease_expires_at: null,
              attempts: 0,
              last_error: null,
              delivered_at: null,
              quarantined_at: null,
            });
            n++;
          }
          return n;
        },
        async listByOutboxEvent(id) {
          return s().deliveries.filter((d) => d.outbox_event_id === id).map((d) => ({ ...d }));
        },
        async claim(limit, now, leaseMs) {
          const rows = s()
            .deliveries.filter((d) => d.delivered_at === null && d.quarantined_at === null && claimable(d, now))
            .slice(0, limit);
          for (const r of rows) {
            r.claimed_at = new Date(now.getTime());
            r.lease_expires_at = new Date(now.getTime() + leaseMs);
          }
          return rows.map((r) => ({ ...r }));
        },
        async markDelivered(id, claimedAt, at) {
          const r = s().deliveries.find((d) => d.id === id);
          if (!r || r.delivered_at !== null || !owns(r, claimedAt)) return false;
          Object.assign(r, { delivered_at: at, lease_expires_at: null, last_error: null });
          return true;
        },
        async markRetry(id, claimedAt, error, retryAt) {
          const r = s().deliveries.find((d) => d.id === id);
          if (!r || r.delivered_at !== null || !owns(r, claimedAt)) return false;
          Object.assign(r, { attempts: r.attempts + 1, last_error: error, lease_expires_at: retryAt });
          return true;
        },
        async quarantine(id, claimedAt, error, at) {
          const r = s().deliveries.find((d) => d.id === id);
          if (!r || r.delivered_at !== null || !owns(r, claimedAt)) return false;
          Object.assign(r, { attempts: r.attempts + 1, last_error: error, quarantined_at: at, lease_expires_at: null });
          return true;
        },
      },
      verifications: {
        async create(data) {
          const row: VerificationRequest = {
            ...data,
            attempts: 0,
            status: 'PENDING',
            outcome: null,
            created_at: tick(),
            confirmed_at: null,
          };
          s().verifications.set(row.id, row);
          return { ...row };
        },
        async findById(id) {
          const r = s().verifications.get(id);
          return r ? { ...r } : null;
        },
        async listPending(key, subjectId) {
          return [...s().verifications.values()]
            .filter(
              (v) =>
                v.status === 'PENDING' &&
                v.identifier_type === key.identifier_type &&
                v.normalized_value === key.normalized_value &&
                (subjectId === null || v.subject_id === subjectId),
            )
            .map((v) => ({ ...v }));
        },
        async update(id, patch) {
          const r = s().verifications.get(id);
          if (!r) throw new Error('not found');
          const next = { ...r, ...patch } as VerificationRequest;
          if ((next.status === 'CONFIRMED') !== (next.confirmed_at !== null)) throw new Error('check violation: confirmed');
          if (next.attempts > next.max_attempts) throw new Error('check violation: attempts');
          s().verifications.set(id, next);
          return { ...next };
        },
      },
      trust: {
        async find(subjectId) {
          const r = s().trust.get(subjectId);
          return r ? { ...r } : null;
        },
        async upsert(subjectId, row, assessedAt) {
          const next: SubjectTrustState = { subject_id: subjectId, ...row, assessed_at: assessedAt };
          s().trust.set(subjectId, next);
          return { ...next };
        },
      },
      entitlements: {
        async find(system, tenant) {
          const r = s().entitlements.get(`${system}|${tenant}`);
          return r ? { ...r } : null;
        },
        async upsert(system, tenant, active) {
          const row: EntitledTenant = { source_system_id: system, tenant_id: tenant, active, updated_at: tick() };
          s().entitlements.set(`${system}|${tenant}`, row);
          return { ...row };
        },
        async deactivateAllExcept(system, keep) {
          let n = 0;
          for (const r of s().entitlements.values()) {
            if (r.source_system_id === system && r.active && !keep.includes(r.tenant_id)) {
              r.active = false;
              n++;
            }
          }
          return n;
        },
      },
      readAudit: {
        async create(data) {
          const row: IntelligenceReadAudit = {
            id: randomUUID(),
            client_id: data.client_id,
            source_system_id: data.source_system_id,
            source_tenant_id: data.source_tenant_id,
            external_talent_id: data.external_talent_id,
            read_kind: data.read_kind,
            outcome: data.outcome,
            access_mode: data.access_mode ?? null,
            reference_id: data.reference_id ?? null,
            subject_id: data.subject_id ?? null,
            fields_returned: data.fields_returned ?? 0,
            created_at: tick(),
          };
          s().readAudit.push(row);
          return { ...row };
        },
      },
      clients: {
        async find(clientId) {
          const r = s().clients.get(clientId);
          return r ? { ...r } : null;
        },
        async upsert(data) {
          const prior = s().clients.get(data.client_id);
          const row: ServiceClient = { ...data, created_at: prior?.created_at ?? tick() };
          s().clients.set(row.client_id, row);
          return { ...row };
        },
      },
    };
  }
}
