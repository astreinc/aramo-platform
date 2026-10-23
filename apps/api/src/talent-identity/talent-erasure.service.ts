import { createHash, randomUUID } from 'node:crypto';

import { TALENT_EVENT_ERASED, buildTalentEventRow } from '@aramo/talent-record';

// TR-15 B2 (DDR §5 — erasure made real) — the delete-pass engine behind the
// `erase-talent` CLI. NO HTTP surface. It automates doc/runbooks/talent-rtbf-
// erasure.md: given a tenant + an ATS TalentRecord id, it resolves the WHOLE
// human (the husk chain of records + the sourced arrivals linked to them),
// then deletes every PII holder child-before-parent, purges the object-storage
// artifacts, appends a retained consent erasure marker, and flips is_anonymized.
//
// S2 Talent Erasure Integrity (Architect rulings F1/F3/F5; TM-L12 auditable
// completion): erasure is FAIL-CLOSED and TRUTHFUL —
//   1. PREFLIGHT before any write: every talent-keyed holder that this pass may
//      not (yet) erase — append-only history pending an authority amendment,
//      commercial / legal records pending a PO/Legal retention class, a legal
//      hold, an interaction shared with another talent — BLOCKS the run. Nothing
//      is skipped silently and nothing is deleted.
//   2. The database pass (every INVENTORY delete + the durable run record) is ONE transaction: any failure rolls everything
//      back — no partial erasure, no orphaned husk-less rows, no marker.
//   3. Object storage cannot join that transaction, so artifacts are recorded
//      durably (consent."TalentErasureRun" / "TalentErasureArtifact") and purged
//      after commit — every version + delete-marker on the versioned bucket. A
//      run is COMPLETED, and the consent.erased marker (what is_anonymized reads)
//      appended, ONLY when every artifact is verifiably purged; otherwise it stays
//      STORAGE_PENDING and `--resume` retries. A re-run is idempotent.
// No blanket bypass exists (F2 not approved). ARAMO-S2-Talent-Erasure-Integrity-
// Amendment-v1.0-LOCKED adds ONLY subject-bound, transaction-bound exceptions,
// enforced by the triggers themselves (§2): the database pass opens its run
// through consent.s2_begin_talent_erasure_run (the SECURITY DEFINER entry point —
// it computes the authorized record set itself and arms the run for THIS
// transaction only), then —
//   §3.1 DELETEs the talent-owned immutable content (note events, document events
//        and packet items, requisition résumé selections);
//   §3.2 REDACTS the enumerated identifying columns of the retained workflow
//        history (children first, while the parent still names the talent), then
//        re-points each parent to ONE fresh tombstone per (record, requisition) —
//        never derived from the id, never persisted — so every (talent,
//        requisition) report grain survives and nothing links across requisitions;
//   §3.3 removes a client restriction's identifying link (reachable only once
//        Legal records the class — until then the preflight blocks it);
// and must leave DB_PASS_IN_PROGRESS before COMMIT (a deferred trigger enforces
// it). Every other operation keeps its original rejection. Commercial / legal
// records, unclassified holders and shared interactions still BLOCK.
//
// Two keyspaces: GROUP A/C holders key on the RECORD id(s); GROUP B (ATS-local
// sourcing, ATI-SEP-1 T10 WP4) keys on the SOURCED-TALENT id(s) linked to those
// records (talent_record."talent_record_sourced_arrival"). The ordering below is
// load-bearing. RETAINED (never deleted): the audit streams —
// audit."ConsentAuditEvent" and audit."MeetingSchedulingAuditEvent" (verified to
// carry only ids, times and statuses) — the append-only record of process.
//
// ATI-SEP-1 T10 WP4 — the retired trust-ledger / identity-index holders (the
// former GROUP B subject keyspace + the orphaned-cluster purge) are gone with
// their schemas; the trust-side facts of the talent now live in Talent
// Intelligence, which receives the talent.erased event this pass writes. ⚠ INVENTORY
// ADDITION beyond the reconcile repoint set (the 19-holder map):
// talent_evidence."TalentEducationEntry" + "TalentCertificationEntry" (TR-7 B1
// PII, never wired into repoint) — included so the erase reaches every holder
// (DDR §5); HALT-noted at Gate-6.

// A minimal raw-SQL executor (pg.Client-shaped). Injected so the CLI points it
// at DATABASE_URL and the acceptance spec points it at its testcontainer. It
// MUST be a single connection: the database pass runs BEGIN … COMMIT on it.
export interface PgExec {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

// S2 F5 — the object-storage purge port. `purge` must remove EVERY version and
// delete-marker of the exact key and report how many remain (0 = verifiably
// purged). The CLI binds ObjectStorageService.purgeObjectAllVersions; specs bind
// a fake. A throw or remaining > 0 is a failed attempt (retryable), never success.
export interface ErasureObjectStore {
  purge(storageKey: string): Promise<{ remaining: number }>;
}

export type ErasureOutcome = 'DRY_RUN' | 'BLOCKED' | 'FAILED' | 'STORAGE_PENDING' | 'COMPLETED';

// The erase-talent CLI exit code per live outcome. Only COMPLETED is 0, so no
// automation can read a blocked, failed or storage-pending run as done.
export const ERASURE_EXIT_CODES: Readonly<Record<Exclude<ErasureOutcome, 'DRY_RUN'>, number>> = {
  COMPLETED: 0,
  BLOCKED: 2,
  STORAGE_PENDING: 3,
  FAILED: 4,
};

// S2 F3 — how a talent-keyed holder is treated by this erasure pass.
export type HolderClassification =
  | 'DELETE' // erased by the INVENTORY delete pass
  | 'BLOCKED_PENDING_AUTHORITY' // append-only history: erasure needs the S2 authority amendment
  | 'PENDING_PO_LEGAL' // commercial / legal record: needs a PO/Legal retention class
  | 'LEGAL_HOLD' // a hold suspends erasure
  | 'BLOCKED_SHARED' // the row also belongs to another person
  | 'PENDING_OUTBOX_DRAIN' // an unpublished outbox event names the talent: retry once it is published
  | 'PENDING_CLASSIFICATION'; // a holder outside every recorded class (S2 holder coverage): needs a ruling

export interface ErasureBlocker {
  holder: string;
  classification: Exclude<HolderClassification, 'DELETE'>;
  count: number;
  reason: string;
  authority: string;
}

// One erasure target: a table + the WHERE that scopes it to this human, built
// from the resolved record-id and sourced-talent-id sets. `s3RefColumn`, when set,
// names a column whose values are S3 object keys to collect before the delete.
interface ErasureStep {
  label: string; // schema."Table"
  // record / record-child: $1 = record ids. sourced: $1 = sourced-talent ids.
  // record-or-sourced: $1 = record ids, $2 = sourced-talent ids.
  keyspace: 'record' | 'record-child' | 'sourced' | 'record-or-sourced';
  where: string; // SQL WHERE body
  s3RefColumn?: string;
}

// The frozen inventory, in delete order (child-before-parent). $1 = record-id
// array (GROUP A/C) or sourced-talent-id array (GROUP B, keyspace sourced).
// Same-schema cascades are NOT listed (talent_record children → TalentRecord).
// pipeline."Pipeline" cascades into append-only history, so the PREFLIGHT blocks
// a talent with any pipeline until the S2 authority amendment lands.
// INC-3 A1-8 — the screening-linked id sets (every one record-keyspace: $1 = record ids).
const SCREENING_SESSIONS = `SELECT ss.id FROM technical_screening."ScreeningSession" ss WHERE ss.talent_record_id = ANY($1::uuid[])`;
// S2 — EVERY communication interaction of the talent: the screening meetings
// (the session's linked interaction, or a screening_session association, which
// covers a meeting scheduled but not yet linked) AND every interaction that has
// the talent as a talent_record subject (calls, email, SMS, meetings). An
// interaction that ALSO names another talent is a PREFLIGHT blocker, never deleted.
const TALENT_PIPELINES = `SELECT id FROM pipeline."Pipeline" WHERE talent_record_id = ANY($1::uuid[])`;
const TALENT_SELECTIONS = `SELECT id FROM client_selection."ClientSelectionProcess" WHERE talent_id = ANY($1::uuid[])`;
const TALENT_INTERVIEWS = `SELECT id FROM client_selection."InterviewSession" WHERE talent_record_id = ANY($1::uuid[])`;
// S2 LOCKED §3.2 — an interaction attached to the talent's pipeline (calls / email /
// meetings filed against the Talent × Requisition) or linked as an interview meeting
// is the talent's interaction too: it is erased, never left behind the tombstone.
const TALENT_INTERACTIONS =
  `SELECT ss.interaction_id FROM technical_screening."ScreeningSession" ss WHERE ss.talent_record_id = ANY($1::uuid[]) AND ss.interaction_id IS NOT NULL` +
  ` UNION SELECT ca.interaction_id FROM communications."CommunicationAssociation" ca WHERE ca.subject_type = 'screening_session' AND ca.subject_id IN (${SCREENING_SESSIONS})` +
  ` UNION SELECT ca.interaction_id FROM communications."CommunicationAssociation" ca WHERE ca.subject_type = 'talent_record' AND ca.subject_id = ANY($1::uuid[])` +
  ` UNION SELECT ca.interaction_id FROM communications."CommunicationAssociation" ca WHERE ca.subject_type = 'pipeline' AND ca.subject_id IN (${TALENT_PIPELINES})` +
  ` UNION SELECT i.meeting_interaction_id FROM client_selection."InterviewSession" i WHERE i.talent_record_id = ANY($1::uuid[]) AND i.meeting_interaction_id IS NOT NULL`;
const TALENT_TRANSCRIPTS =
  `SELECT tl.conversation_transcript_id FROM technical_screening."ScreeningTranscriptLink" tl WHERE tl.session_id IN (${SCREENING_SESSIONS})` +
  ` UNION SELECT ct.id FROM conversation_transcript."ConversationTranscript" ct WHERE ct.interaction_id IN (${TALENT_INTERACTIONS})`;
const TALENT_CI_RUNS =
  `SELECT r.id FROM conversation_intelligence."ConversationIntelligenceRun" r WHERE r.screening_session_id IN (${SCREENING_SESSIONS})` +
  ` OR r.conversation_transcript_id IN (${TALENT_TRANSCRIPTS})`;
const TALENT_DOCUMENTS = `SELECT document_id FROM documents."DocumentAssociation" WHERE resource_type = 'TALENT' AND resource_id = ANY($1::uuid[])`;
const TALENT_ACTIVITIES = `SELECT id FROM activity."Activity" WHERE subject_type = 'talent_record' AND subject_id = ANY($1::uuid[])`;
// ATI-SEP-1 A2 — a Save that already created the record but has not yet marked
// the draft PROMOTED holds the id only as its reservation; erase that draft too
// (a re-Save must never re-create an erased Talent).
const TALENT_INTAKE_DRAFTS = `SELECT id FROM talent_evidence."TalentIntakeDraft" WHERE promoted_talent_record_id = ANY($1::uuid[]) OR save_reserved_talent_record_id = ANY($1::uuid[])`;
// A payload (jsonb, read as text) that names any of the record ids.
const NAMES_A_RECORD = (col: string): string =>
  `${col}::text LIKE ANY (ARRAY(SELECT '%' || r::text || '%' FROM unnest($1::uuid[]) r))`;
// The ordinary (trigger-free) transactional outboxes whose payloads carry talent ids.
// offer / placement outboxes are immutable commercial records: guarded, never here.
const ORDINARY_OUTBOXES = [
  'canonicalization."OutboxEvent"',
  'client_selection."OutboxEvent"',
  'consent."OutboxEvent"',
  'documents."OutboxEvent"',
  'sign."OutboxEvent"',
  'pipeline."OutboxEvent"',
  'selection."OutboxEvent"',
  'submittal."OutboxEvent"',
] as const;

// S2 LOCKED §3.2 — the enumerated redactions of retained workflow history, run
// BEFORE the INVENTORY deletes and the tombstones (each trigger resolves the owning
// talent through the parent, which must still name the talent). The SET lists are
// exactly the trigger-enforced patches; a single extra column is rejected by the DB.
interface ErasureRedaction {
  label: string;
  set: string;
  where: string; // $1 = record ids
}
const REDACTIONS: ErasureRedaction[] = [
  { label: 'pipeline."PipelineStatusHistory"', set: `note = NULL`, where: `pipeline_id IN (${TALENT_PIPELINES}) AND note IS NOT NULL` },
  { label: 'pipeline."PipelineDisposition"', set: `reason = 'REDACTED', note = NULL, source_provenance = NULL`, where: `pipeline_id IN (${TALENT_PIPELINES})` },
  {
    label: 'pipeline."PipelineEntryProvenance"',
    set: `external_object_type = NULL, external_object_id = NULL, external_event_id = NULL, source_connection_id = NULL, initiated_by_id = NULL, observed_at = NULL, metadata = '{}'::jsonb`,
    where: `pipeline_id IN (${TALENT_PIPELINES})`,
  },
  {
    label: 'client_selection."ClientSelectionEvent"',
    set: `event_payload = '{}'::jsonb`,
    where: `(subject_type = 'process' AND subject_id IN (${TALENT_SELECTIONS})) OR (subject_type = 'session' AND subject_id IN (${TALENT_INTERVIEWS}))`,
  },
  // §3.3 — reachable only when the preflight admits it (today it blocks every restriction).
  {
    label: 'client_talent_restriction."ClientTalentRestriction"',
    set: `talent_record_id = gen_random_uuid(), source_reference = 'erased:' || gen_random_uuid()::text, raw_source_value = NULL, asserting_organization_reference = NULL, asserting_contact_reference = NULL, close_source_reference = NULL`,
    where: `talent_record_id = ANY($1::uuid[])`,
  },
  // The activity timeline of the talent's pipelines / interviews (status-change notes,
  // interview feedback) is retained for the activity reports; its free text is cleared
  // with the RN-1 redact-never-delete columns (an ordinary table: no new authority).
  {
    label: 'activity."Activity"',
    set: `notes = NULL, redacted_at = COALESCE(redacted_at, now()), redaction_reason_code = COALESCE(redaction_reason_code, 'TALENT_ERASURE'), redaction_reason = 'talent erasure'`,
    where: `(subject_type = 'pipeline' AND subject_id IN (${TALENT_PIPELINES})) OR (subject_type = 'interview_session' AND subject_id IN (${TALENT_INTERVIEWS}))`,
  },
];

// S2 LOCKED §3.2 — the parents re-pointed to the per-(record, requisition)
// tombstone held in the transaction-local temp table s2_erasure_tombstone.
const TOMBSTONES: Array<{ label: string; sql: string }> = [
  {
    label: 'pipeline."Pipeline"',
    sql: `UPDATE pipeline."Pipeline" p SET talent_record_id = t.tombstone FROM pg_temp.s2_erasure_tombstone t
           WHERE p.talent_record_id = t.record_id AND p.requisition_id = t.requisition_id AND p.talent_record_id = ANY($1::uuid[])`,
  },
  {
    label: 'client_selection."InterviewSession"',
    sql: `UPDATE client_selection."InterviewSession" i SET talent_record_id = t.tombstone, meeting_interaction_id = NULL FROM pg_temp.s2_erasure_tombstone t
           WHERE i.talent_record_id = t.record_id AND i.requisition_id = t.requisition_id AND i.talent_record_id = ANY($1::uuid[])`,
  },
  {
    label: 'client_selection."ClientSelectionProcess"',
    sql: `UPDATE client_selection."ClientSelectionProcess" c SET talent_id = t.tombstone, submittal_id = gen_random_uuid() FROM pg_temp.s2_erasure_tombstone t
           WHERE c.talent_id = t.record_id AND c.requisition_id = t.requisition_id AND c.talent_id = ANY($1::uuid[])`,
  },
];
const TOMBSTONE_KEYS = `SELECT talent_record_id AS record_id, requisition_id FROM pipeline."Pipeline" WHERE talent_record_id = ANY($1::uuid[])
  UNION SELECT talent_id, requisition_id FROM client_selection."ClientSelectionProcess" WHERE talent_id = ANY($1::uuid[])
  UNION SELECT talent_record_id, requisition_id FROM client_selection."InterviewSession" WHERE talent_record_id = ANY($1::uuid[])`;

// Gate-5 C — the parents whose FK-checked children the pass reads, redacts or deletes.
// FOR UPDATE conflicts with the KEY SHARE lock a child INSERT takes on its parent.
const PARENT_LOCKS: ReadonlyArray<Pick<ErasureStep, 'keyspace'> & { sql: string }> = [
  { keyspace: 'record', sql: `SELECT 1 FROM pipeline."Pipeline" WHERE talent_record_id = ANY($1::uuid[]) FOR UPDATE` },
  { keyspace: 'record', sql: `SELECT 1 FROM client_selection."ClientSelectionProcess" WHERE talent_id = ANY($1::uuid[]) FOR UPDATE` },
  { keyspace: 'record', sql: `SELECT 1 FROM client_selection."InterviewSession" WHERE talent_record_id = ANY($1::uuid[]) FOR UPDATE` },
  { keyspace: 'record', sql: `SELECT 1 FROM activity."Activity" WHERE (subject_type = 'talent_record' AND subject_id = ANY($1::uuid[])) OR (subject_type = 'pipeline' AND subject_id IN (${TALENT_PIPELINES})) OR (subject_type = 'interview_session' AND subject_id IN (${TALENT_INTERVIEWS})) FOR UPDATE` },
  { keyspace: 'record', sql: `SELECT 1 FROM documents."Document" WHERE id IN (${TALENT_DOCUMENTS}) FOR UPDATE` },
  { keyspace: 'record', sql: `SELECT 1 FROM technical_screening."ScreeningSession" WHERE talent_record_id = ANY($1::uuid[]) FOR UPDATE` },
  { keyspace: 'record', sql: `SELECT 1 FROM communications."CommunicationInteraction" WHERE id IN (${TALENT_INTERACTIONS}) FOR UPDATE` },
];

const INVENTORY: ErasureStep[] = [
  // ---- GROUP A operational non-cascade EVENT children (delete before parents) ----
  { label: 'submittal."TalentSubmittalEvent"', keyspace: 'record-child', where: `submittal_id IN (SELECT id FROM submittal."TalentSubmittalRecord" WHERE talent_id = ANY($1::uuid[]))` },
  { label: 'selection."TalentSelectionEvent"', keyspace: 'record-child', where: `selection_id IN (SELECT id FROM selection."TalentSelection" WHERE talent_id = ANY($1::uuid[]))` },
  { label: 'examination."ExaminationOverride"', keyspace: 'record-child', where: `examination_id IN (SELECT id FROM examination."TalentJobExamination" WHERE talent_id = ANY($1::uuid[]))` },
  // ---- GROUP A operational holders (record keyspace) ----
  // pipeline."Pipeline" is NOT deleted: it is retained and tombstoned (S2 LOCKED §3.2).
  // S2 LOCKED §3.1 — the talent's requisition résumé selections (subject-bound DELETE).
  { label: 'pipeline."TalentRequisitionResume"', keyspace: 'record', where: `talent_record_id = ANY($1::uuid[])` },
  { label: 'submittal."TalentSubmittalRecord"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'evidence."TalentJobEvidencePackage"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'selection."TalentSelection"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'examination."TalentJobExamination"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentSkillEvidence"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentWorkHistoryEntry"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentContactMethod"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentRateExpectation"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentWorkAuthorization"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentDocument"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  // DOC-1b — the canonical documents.Document quartet for a talent (linked via
  // DocumentAssociation.resource_type='TALENT' AND resource_id=talent_id). The S3
  // bytes moved from TalentDocument.file_storage_ref to DocumentArtifact.
  // storage_locator. FK-safe order: artifact -> revision -> event -> document
  // (deleting the Document cascades its associations, per the DOC-1b FK change).
  { label: 'documents."DocumentArtifact"', keyspace: 'record', where: `document_id IN (${TALENT_DOCUMENTS})`, s3RefColumn: 'storage_locator' },
  { label: 'documents."DocumentRevision"', keyspace: 'record', where: `document_id IN (${TALENT_DOCUMENTS})` },
  // S2 LOCKED §3.1 — DocumentEvent (subject-bound DELETE; the trigger re-checks that the
  // document belongs to this talent only) and the RESTRICT-FK packet membership.
  { label: 'documents."DocumentEvent"', keyspace: 'record', where: `document_id IN (${TALENT_DOCUMENTS})` },
  { label: 'documents."DocumentPacketItem"', keyspace: 'record', where: `document_id IN (${TALENT_DOCUMENTS})` },
  // S2 holder coverage — a document requirement raised against the talent (waiver text).
  { label: 'documents."DocumentRequirement"', keyspace: 'record', where: `resource_type = 'TALENT' AND resource_id = ANY($1::uuid[])` },
  { label: 'documents."Document"', keyspace: 'record', where: `id IN (${TALENT_DOCUMENTS})` },
  { label: 'talent_evidence."TalentDerivedSnapshot"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  // ⚠ INVENTORY ADDITION (TR-7 B1 PII; absent from the reconcile repoint set — HALT-noted):
  { label: 'talent_evidence."TalentEducationEntry"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentCertificationEntry"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  // ---- S2 F3 — talent-keyed PII holders that were ABSENT from the inventory and carry no
  //      append-only protection (classified DELETE under TR-15 DDR §5 "every holder"). ----
  { label: 'talent_evidence."TalentProjectExperience"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentResumeDefault"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentResumeEdition"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."ResumeExtractionDraft"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentIntakeOutboxEvent"', keyspace: 'record', where: `subject_type = 'talent_intake_draft' AND subject_id IN (SELECT d.id::text FROM talent_evidence."TalentIntakeDraft" d WHERE d.promoted_talent_record_id = ANY($1::uuid[]) OR d.save_reserved_talent_record_id = ANY($1::uuid[]))` },
  // ATI-SEP-1 A3 — the ATS talent outbox: every earlier talent.* event of the
  // erased records (ids only, published or not). The talent.erased rows this pass
  // writes (below, after the inventory) are what downstream consumers act on.
  { label: 'talent_record."TalentEventOutbox"', keyspace: 'record', where: `subject_id = ANY($1::uuid[]) AND event_type <> '${TALENT_EVENT_ERASED}'` },
  { label: 'talent_evidence."TalentIntakeDraft"', keyspace: 'record', where: `id IN (${TALENT_INTAKE_DRAFTS})`, s3RefColumn: 'storage_key' },
  { label: 'examination."CanonicalMatchShadowObservation"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  // ---- GROUP A polymorphic holders (discriminator MANDATORY — shared id space) ----
  { label: 'saved_list."SavedListEntry"', keyspace: 'record', where: `item_type = 'talent_record' AND item_id = ANY($1::uuid[])` },
  { label: 'attachment."Attachment"', keyspace: 'record', where: `owner_type = 'talent' AND owner_id = ANY($1::uuid[])`, s3RefColumn: 'storage_key' },
  // S2 LOCKED §3.1 — the talent's note events (subject-bound DELETE), before their notes.
  { label: 'activity."ActivityNoteEvent"', keyspace: 'record', where: `activity_id IN (${TALENT_ACTIVITIES})` },
  { label: 'activity."Activity"', keyspace: 'record', where: `subject_type = 'talent_record' AND subject_id = ANY($1::uuid[])` },
  { label: 'task."Task"', keyspace: 'record', where: `owner_type = 'talent_record' AND owner_id = ANY($1::uuid[])` },
  // ---- GROUP A consent LEDGER (record keyspace; audit is RETAINED, not here) ----
  { label: 'consent."TalentConsentEvent"', keyspace: 'record', where: `talent_record_id = ANY($1::uuid[])` },
  // ---- S2 holder coverage — payload-borne references in trigger-free tables: the cached
  //      idempotent responses and the PUBLISHED outbox events naming the talent (an
  //      UNPUBLISHED one blocks in the preflight until it drains). ----
  { label: 'consent."IdempotencyKey"', keyspace: 'record', where: NAMES_A_RECORD('response_body') },
  { label: 'documents."IdempotencyKey"', keyspace: 'record', where: NAMES_A_RECORD('response_body') },
  { label: 'sign."IdempotencyKey"', keyspace: 'record', where: NAMES_A_RECORD('response_body') },
  ...ORDINARY_OUTBOXES.map((label): ErasureStep => ({ label, keyspace: 'record', where: `published_at IS NOT NULL AND ${NAMES_A_RECORD('event_payload')}` })),
  // ---- GROUP B ATS-local sourcing (ATI-SEP-1 T10 WP4). The sourced arrivals LINKED to the
  //      erased records (talent_record_sourced_arrival: PROMOTED / ADVISORY_APPROVED — the
  //      same human) are erased with their raw payloads (declared name, contact, the stored
  //      payload object), keyed by RawPayloadReference.sourced_talent_id (WP2). Then every
  //      within-tenant duplicate advisory naming an erased record OR an erased arrival, and
  //      the link rows themselves (both also cascade from TalentRecord; listed explicitly so
  //      the dry-run counts them and the coverage proof sees them). ----
  { label: 'ingestion."RawPayloadReference"', keyspace: 'sourced', where: `sourced_talent_id = ANY($1::uuid[])`, s3RefColumn: 'storage_ref' },
  { label: 'sourced_talent."SourcedTalent"', keyspace: 'sourced', where: `id = ANY($1::uuid[])` },
  { label: 'talent_record."talent_duplicate_advisory"', keyspace: 'record-or-sourced', where: `talent_record_a_id = ANY($1::uuid[]) OR talent_record_b_id = ANY($1::uuid[]) OR sourced_talent_id = ANY($2::uuid[])` },
  { label: 'talent_record."talent_record_sourced_arrival"', keyspace: 'record-or-sourced', where: `talent_record_id = ANY($1::uuid[]) OR sourced_talent_id = ANY($2::uuid[])` },
  // ATI-SEP-1 T8 — the ATS ↔ Talent Intelligence link + the TI → ATS inbound event inbox
  // (ids only) for the erased records (the link also cascades from TalentRecord).
  { label: 'talent_record."intelligence_link"', keyspace: 'record', where: `talent_record_id = ANY($1::uuid[])` },
  { label: 'talent_record."talent_intelligence_inbound_event"', keyspace: 'record', where: `talent_record_id = ANY($1::uuid[])` },
  // ---- Enterprise Search GS-2A semantic index (record keyspace) — cross-schema UUID ref to
  //      talent_record.TalentRecord.id, NO FK (repo invariant). The embedding is a PII-derived
  //      holder, so erasure reaches it EXPLICITLY here (deleted before the husk record; the dry-run
  //      counts it) rather than via a cross-schema cascade this codebase does not use. ----
  { label: 'talent_embedding."TalentEmbedding"', keyspace: 'record', where: `talent_record_id = ANY($1::uuid[])` },
  // ---- TIP-E2E INC-3 technical screening (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §10.2) — child before
  //      parent THROUGH the session (children carry no talent_record_id; sessions are deleted
  //      last so the subselects still resolve; the husk chain covers merged sessions). Plain
  //      governed DELETEs — the screening tables carry NO delete trigger and NO marker (§10.1).
  //      The published evidence is Talent Intelligence's (talent.erased below). ----
  // ---- TIP-E2E INC-3 A1-8 (Part H) + S2 F3 — the talent's conversation data, erased BEFORE the
  //      screening rows its subselects resolve through: CI runs (+ claims / citations / drafts)
  //      → the conversation transcripts (+ source AND normalized object-storage artifacts) →
  //      EVERY interaction of the talent (screening meetings and general calls / email / SMS /
  //      meetings): provider events, scheduling operations, dispositions, associations. ----
  { label: 'conversation_intelligence."ConversationIntelligenceCitation"', keyspace: 'record-child', where: `claim_id IN (SELECT k.id FROM conversation_intelligence."ConversationIntelligenceClaim" k WHERE k.run_id IN (${TALENT_CI_RUNS}))` },
  { label: 'conversation_intelligence."ConversationIntelligenceClaim"', keyspace: 'record-child', where: `run_id IN (${TALENT_CI_RUNS})` },
  { label: 'conversation_intelligence."ConversationIntelligenceDraft"', keyspace: 'record-child', where: `run_id IN (${TALENT_CI_RUNS})` },
  { label: 'conversation_intelligence."ConversationIntelligenceRun"', keyspace: 'record-child', where: `id IN (${TALENT_CI_RUNS})` },
  { label: 'conversation_transcript."ConversationTranscript"', keyspace: 'record-child', where: `id IN (${TALENT_TRANSCRIPTS})`, s3RefColumn: 'source_artifact_ref' },
  { label: 'communications."CommunicationProviderEvent"', keyspace: 'record-child', where: `interaction_id IN (${TALENT_INTERACTIONS})` },
  { label: 'communications."MeetingSchedulingOperation"', keyspace: 'record-child', where: `interaction_id IN (${TALENT_INTERACTIONS}) OR screening_session_id IN (${SCREENING_SESSIONS}) OR talent_record_id = ANY($1::uuid[])` },
  // The interaction goes BEFORE its associations: the screening_session association is
  // the evidence that identifies a scheduled-but-unlinked meeting (dispositions and
  // associations cascade with it; their own steps then sweep any residue).
  { label: 'communications."CommunicationInteraction"', keyspace: 'record-child', where: `id IN (${TALENT_INTERACTIONS})` },
  { label: 'communications."CommunicationDisposition"', keyspace: 'record-child', where: `interaction_id IN (${TALENT_INTERACTIONS})` },
  { label: 'communications."CommunicationAssociation"', keyspace: 'record-child', where: `interaction_id IN (${TALENT_INTERACTIONS})` },
  // ---- INC-3 A1-8 — the A1 screening tables, child before parent through the session ----
  { label: 'technical_screening."ScreeningFindingCitation"', keyspace: 'record-child', where: `finding_id IN (SELECT f.id FROM technical_screening."ScreeningFinding" f WHERE f.session_id IN (${SCREENING_SESSIONS}))` },
  { label: 'technical_screening."ScreeningAssistSuggestion"', keyspace: 'record-child', where: `session_id IN (${SCREENING_SESSIONS})` },
  { label: 'technical_screening."ScreeningNote"', keyspace: 'record-child', where: `session_id IN (${SCREENING_SESSIONS})` },
  { label: 'technical_screening."ScreeningQuestion"', keyspace: 'record-child', where: `session_id IN (${SCREENING_SESSIONS})` },
  { label: 'technical_screening."ScreeningAiGeneration"', keyspace: 'record-child', where: `session_id IN (${SCREENING_SESSIONS})` },
  { label: 'technical_screening."ScreeningTranscriptLink"', keyspace: 'record-child', where: `session_id IN (${SCREENING_SESSIONS})` },
  { label: 'technical_screening."ScreeningEvent"', keyspace: 'record-child', where: `session_id IN (SELECT id FROM technical_screening."ScreeningSession" WHERE talent_record_id = ANY($1::uuid[]))` },
  { label: 'technical_screening."ScreeningEvidencePublication"', keyspace: 'record-child', where: `session_id IN (SELECT id FROM technical_screening."ScreeningSession" WHERE talent_record_id = ANY($1::uuid[]))` },
  { label: 'technical_screening."ScreeningFinding"', keyspace: 'record-child', where: `session_id IN (SELECT id FROM technical_screening."ScreeningSession" WHERE talent_record_id = ANY($1::uuid[]))` },
  { label: 'technical_screening."ScreeningSession"', keyspace: 'record', where: `talent_record_id = ANY($1::uuid[])` },
  // ---- GROUP C the husk records (record keyspace) — cascades resume_text (S3) + provenance + contradiction ----
  { label: 'talent_record."TalentRecord"', keyspace: 'record', where: `id = ANY($1::uuid[])` },
];

// The NORMALIZED transcript artifact (the source artifact is the
// ConversationTranscript step's s3RefColumn). Collected before any delete.
const TRANSCRIPT_NORMALIZED_S3 = {
  label: 'conversation_transcript."ConversationTranscript"',
  s3RefColumn: 'normalized_artifact_ref',
  where: `id IN (${TALENT_TRANSCRIPTS})`,
  keyspace: 'record' as const,
};

// Same-schema S3-bearing cascade child collected separately (falls away with
// TalentRecord, but its S3 object must be enumerated first).
const RESUME_TEXT_S3 = {
  label: 'talent_record."talent_resume_text"',
  s3RefColumn: 'storage_key',
  where: `talent_record_id = ANY($1::uuid[])`,
  keyspace: 'record' as const,
};

// S2 F3 — the PREFLIGHT guards: every talent-keyed holder this pass may NOT erase
// today. Any row present BLOCKS the run before a single write (never skipped).
// keyspace 'record' binds $1 = record ids; 'tenant' binds $1 = the tenant id.
interface HolderGuard {
  holder: string;
  classification: Exclude<HolderClassification, 'DELETE'>;
  keyspace: 'record' | 'tenant';
  sql: string; // SELECT count(*)::int AS n …
  reason: string;
  authority: string;
}
const PO_LEGAL = 'PO/Legal retention class (TM-L12 legal hold / retention; ADR-0007 Decision F)';
const CLASSIFY = 'Architect / PO holder classification (S2 holder coverage)';
// The talent's contact values (lower-cased) — captured by the preflight, before any delete.
// ATI-SEP-1 T10 WP4 — the sourced arrivals linked to the records (the same human).
const TALENT_SOURCED_ARRIVALS = `SELECT sa.sourced_talent_id FROM talent_record."talent_record_sourced_arrival" sa WHERE sa.talent_record_id = ANY($1::uuid[])`;
const TALENT_CONTACT_VALUES = `SELECT lower(cm.value) FROM talent_evidence."TalentContactMethod" cm WHERE cm.talent_id = ANY($1::uuid[]) AND cm.value IS NOT NULL AND length(cm.value) >= 5`;
export const ERASURE_HOLDER_GUARDS: readonly HolderGuard[] = [
  // ---- legal hold (TM-L12 "must not erase data subject to legal hold") ----
  { holder: 'identity."Tenant".legal_hold', classification: 'LEGAL_HOLD', keyspace: 'tenant', sql: `SELECT count(*)::int AS n FROM identity."Tenant" WHERE id = $1::uuid AND legal_hold = true`, reason: 'the tenant is under legal hold', authority: 'TM-L12' },
  { holder: 'documents."DocumentArtifact".legal_hold', classification: 'LEGAL_HOLD', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM documents."DocumentArtifact" WHERE document_id IN (${TALENT_DOCUMENTS}) AND legal_hold = true`, reason: 'a talent document artifact is under legal hold', authority: 'TM-L12' },
  { holder: 'documents."DocumentArtifact".retain_until', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM documents."DocumentArtifact" WHERE document_id IN (${TALENT_DOCUMENTS}) AND retain_until IS NOT NULL AND retain_until > now()`, reason: 'a talent document artifact is inside its retention window', authority: PO_LEGAL },
  // ---- append-only history is now reached by its S2 LOCKED §3.1 / §3.2 disposition (DELETE or
  //      redact + tombstone) — no longer a blocker. §3.3: a client talent restriction may lose
  //      its identifying link only once Legal records whether its class carries an enforceable
  //      retention obligation; no such class (and no indicator to read) exists yet, so EVERY
  //      restriction blocks (fail-closed, never erase-by-default). ----
  { holder: 'client_talent_restriction."ClientTalentRestriction"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM client_talent_restriction."ClientTalentRestriction" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'client talent restriction: no Legal-recorded retention class yet (S2 LOCKED §3.3)', authority: PO_LEGAL },
  // ---- commercial / legal records (retention class needed) ----
  { holder: 'offer."Offer"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM offer."Offer" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'offer (compensation; append-only events and revisions)', authority: PO_LEGAL },
  { holder: 'placement."PlacementProcess"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM placement."PlacementProcess" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'placement process (commercial record)', authority: PO_LEGAL },
  { holder: 'placement."ContractAssignment"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM placement."ContractAssignment" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'contract assignment (commercial record)', authority: PO_LEGAL },
  { holder: 'placement."AssignmentRateVersion"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM placement."AssignmentRateVersion" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'pay / bill rate history (financial record)', authority: PO_LEGAL },
  { holder: 'placement."CommercialRevisionProposal"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM placement."CommercialRevisionProposal" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'commercial revision proposal (financial record)', authority: PO_LEGAL },
  { holder: 'placement."PermanentPlacement"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM placement."PermanentPlacement" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'permanent placement (fee / guarantee record)', authority: PO_LEGAL },
  { holder: 'placement."PermanentPlacementRemedy"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM placement."PermanentPlacementRemedy" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'guarantee remedy (financial record)', authority: PO_LEGAL },
  { holder: 'submittal_policy."SubmittalConsumption"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM submittal_policy."SubmittalConsumption" WHERE talent_record_id = ANY($1::uuid[])`, reason: 'submittal consumption (client commercial policy record)', authority: PO_LEGAL },
  { holder: 'sign."EnvelopeDocument"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM sign."EnvelopeDocument" WHERE document_ref IN (${TALENT_DOCUMENTS})`, reason: 'e-signature envelope over a talent document (executed-record retention; signer PII)', authority: PO_LEGAL },
  { holder: 'offer."OutboxEvent" / placement."OutboxEvent"', classification: 'PENDING_PO_LEGAL', keyspace: 'record', sql: `SELECT (SELECT count(*) FROM offer."OutboxEvent" WHERE ${NAMES_A_RECORD('event_payload')}) + (SELECT count(*) FROM placement."OutboxEvent" WHERE ${NAMES_A_RECORD('event_payload')})::int AS n`, reason: 'immutable commercial outbox event names the talent', authority: PO_LEGAL },
  // ---- an unpublished outbox event still has to reach its consumers: retry after it drains ----
  { holder: 'OutboxEvent (unpublished)', classification: 'PENDING_OUTBOX_DRAIN', keyspace: 'record', sql: `SELECT (${ORDINARY_OUTBOXES.map((o) => `(SELECT count(*) FROM ${o} WHERE published_at IS NULL AND ${NAMES_A_RECORD('event_payload')})`).join(' + ')})::int AS n`, reason: 'an unpublished outbox event names the talent — retry once the outbox has drained', authority: 'none (transient)' },
  // ---- S2 holder coverage — holders outside every recorded class: they name the talent (by id,
  //      or by a contact value of the talent) but no ruling says whether they are erased,
  //      redacted or retained. They BLOCK until classified (truthful: never a silent residue). ----
  { holder: 'policy_store."PolicyDecisionRecord"', classification: 'PENDING_CLASSIFICATION', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM policy_store."PolicyDecisionRecord" WHERE ${NAMES_A_RECORD('inputs')}`, reason: 'a policy decision record names the talent in its inputs', authority: CLASSIFY },
  { holder: 'ai_draft."AiDraftEvent"', classification: 'PENDING_CLASSIFICATION', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM ai_draft."AiDraftEvent" WHERE ${NAMES_A_RECORD('event_payload')}`, reason: 'an immutable AI-draft event names the talent', authority: CLASSIFY },
  // ATI-SEP-1 T10 WP4 — a sourced arrival LINKED to the erased records is erased (GROUP B);
  // only an UNLINKED one that carries a contact value of the talent still blocks.
  { holder: 'sourced_talent."SourcedTalent"', classification: 'PENDING_CLASSIFICATION', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM sourced_talent."SourcedTalent" s WHERE (s.normalized_email IN (${TALENT_CONTACT_VALUES}) OR s.normalized_phone IN (${TALENT_CONTACT_VALUES})) AND s.id NOT IN (${TALENT_SOURCED_ARRIVALS})`, reason: 'an unlinked sourced-talent record carries a contact value of the talent', authority: CLASSIFY },
  { holder: 'import."ImportFailure"', classification: 'PENDING_CLASSIFICATION', keyspace: 'record', sql: `SELECT count(*)::int AS n FROM import."ImportFailure" f WHERE EXISTS (SELECT 1 FROM (${TALENT_CONTACT_VALUES}) v(value) WHERE f.original_row_data::text ILIKE '%' || v.value || '%')`, reason: 'a failed import row carries a contact value of the talent', authority: CLASSIFY },
  // ---- shared rows (another person's data) ----
  // S2 LOCKED §5 — an interaction of this talent that ALSO belongs to another person (named
  // directly, or through another talent's pipeline or screening session) is never deleted or
  // partially erased: BLOCKED_SHARED, with its transcripts (speaker attribution cannot
  // separate one participant compliantly).
  { holder: 'communications."CommunicationInteraction" (shared)', classification: 'BLOCKED_SHARED', keyspace: 'record', sql: `SELECT count(DISTINCT ca.interaction_id)::int AS n FROM communications."CommunicationAssociation" ca WHERE ca.interaction_id IN (${TALENT_INTERACTIONS}) AND (
      (ca.subject_type = 'talent_record' AND ca.subject_id <> ALL($1::uuid[]))
      OR (ca.subject_type = 'pipeline' AND ca.subject_id NOT IN (${TALENT_PIPELINES}))
      OR (ca.subject_type = 'screening_session' AND ca.subject_id NOT IN (${SCREENING_SESSIONS})))`, reason: 'an interaction of this talent also belongs to another talent', authority: 'TM-L12 (operator review)' },
  // S2 LOCKED §3.1 — a document of this talent that is ALSO associated with another talent.
  { holder: 'documents."Document" (shared)', classification: 'BLOCKED_SHARED', keyspace: 'record', sql: `SELECT count(DISTINCT da.document_id)::int AS n FROM documents."DocumentAssociation" da WHERE da.document_id IN (${TALENT_DOCUMENTS}) AND da.resource_type = 'TALENT' AND da.resource_id <> ALL($1::uuid[])`, reason: 'a document of this talent is also associated with another talent', authority: 'TM-L12 (operator review)' },
];

export interface ErasureScope {
  record_ids: string[]; // the husk chain (every record of the human)
  sourced_talent_ids: string[]; // the sourced arrivals linked to those records
  s3_keys: string[]; // every object-storage key to purge (deduplicated)
}

export interface ErasureStepResult {
  table: string;
  count: number; // rows counted (dry-run) or deleted (execute)
  status: 'counted' | 'deleted' | 'redacted' | 'tombstoned' | 'rolled_back' | 'failed';
  error?: string;
}

export interface ErasureStorageStatus {
  total: number;
  purged: number;
  pending: number;
  failed: number;
}

export interface ErasureReport {
  tenant_id: string;
  record_id: string;
  mode: 'dry-run' | 'execute' | 'resume';
  // S2 — the ONE truthful verdict. Only COMPLETED is a completed erasure.
  outcome: ErasureOutcome;
  failure?: string;
  blockers: ErasureBlocker[];
  run_id: string | null;
  scope: ErasureScope;
  steps: ErasureStepResult[];
  retained: string[]; // audit tables deliberately NOT deleted
  storage: ErasureStorageStatus;
  erasure_marker_appended: boolean;
  is_anonymized_flipped: boolean; // true ONLY when the run is COMPLETED
  total_rows: number; // rows deleted (or, in a dry-run, that would be)
  redacted_rows: number; // retained rows redacted or tombstoned (S2 LOCKED §3.2 / §3.3)
}

export const RETAINED = [
  'audit."ConsentAuditEvent"',
  'audit."MeetingSchedulingAuditEvent"',
];

// S2 holder coverage — every table this pass reaches (DELETE, redact or tombstone),
// for the schema-driven coverage proof (a new talent-keyed holder must be classified).
export const ERASURE_REACHED_HOLDERS: readonly string[] = [
  ...new Set([...INVENTORY.map((s) => s.label), ...REDACTIONS.map((r) => r.label), ...TOMBSTONES.map((t) => t.label), RESUME_TEXT_S3.label]),
];

interface RunRow {
  id: string;
  state: 'STORAGE_PENDING' | 'COMPLETED';
  record_ids: string[];
}

export class TalentErasureService {
  // Resolve the WHOLE human from one record id: the husk chain (records linked
  // by supersession, both directions) + the sourced arrivals linked to those
  // records + the object-storage keys. Read-only. `exists` = the anchor record is present.
  async resolveScope(pg: PgExec, tenantId: string, recordId: string): Promise<ErasureScope> {
    const recRows = await pg.query<{ id: string }>(
      `WITH RECURSIVE chain(id, sby) AS (
         SELECT id, superseded_by_record_id FROM talent_record."TalentRecord"
         WHERE tenant_id = $1::uuid AND id = $2::uuid
         UNION
         SELECT t.id, t.superseded_by_record_id FROM talent_record."TalentRecord" t
           JOIN chain c ON (t.superseded_by_record_id = c.id OR t.id = c.sby)
         WHERE t.tenant_id = $1::uuid
       )
       SELECT DISTINCT id FROM chain`,
      [tenantId, recordId],
    );
    const record_ids = recRows.rows.map((r) => r.id);
    if (record_ids.length === 0) record_ids.push(recordId); // never resolves empty

    const srcRows = await pg.query<{ id: string }>(
      `SELECT DISTINCT sourced_talent_id AS id FROM talent_record."talent_record_sourced_arrival"
        WHERE tenant_id = $1::uuid AND talent_record_id = ANY($2::uuid[])`,
      [tenantId, record_ids],
    );
    const sourced_talent_ids = srcRows.rows.map((r) => r.id);
    const s3_keys = await this.collectStorageKeys(pg, { record_ids, sourced_talent_ids, s3_keys: [] });
    return { record_ids, sourced_talent_ids, s3_keys };
  }

  // Every object-storage key the delete pass orphans: each s3-bearing INVENTORY
  // step, the résumé-text cascade child and the normalized transcript artifact.
  private async collectStorageKeys(pg: PgExec, scope: ErasureScope): Promise<string[]> {
    const sources: Array<{ label: string; col: string; where: string; keyspace: ErasureStep['keyspace'] }> = [
      ...INVENTORY.filter((s) => s.s3RefColumn !== undefined).map((s) => ({
        label: s.label,
        col: s.s3RefColumn as string,
        where: s.where,
        keyspace: s.keyspace,
      })),
      { label: RESUME_TEXT_S3.label, col: RESUME_TEXT_S3.s3RefColumn, where: RESUME_TEXT_S3.where, keyspace: RESUME_TEXT_S3.keyspace },
      { label: TRANSCRIPT_NORMALIZED_S3.label, col: TRANSCRIPT_NORMALIZED_S3.s3RefColumn, where: TRANSCRIPT_NORMALIZED_S3.where, keyspace: TRANSCRIPT_NORMALIZED_S3.keyspace },
    ];
    const keys = new Set<string>();
    for (const src of sources) {
      const rows = await pg.query<{ k: string | null }>(
        `SELECT "${src.col}" AS k FROM ${src.label} WHERE ${src.where}`,
        this.keyParams({ keyspace: src.keyspace }, scope),
      );
      for (const r of rows.rows) if (r.k !== null && r.k !== undefined && r.k !== '') keys.add(r.k);
    }
    return [...keys];
  }

  // S2 F3 — the PREFLIGHT. Read-only; every present guard is a blocker.
  async preflight(pg: PgExec, tenantId: string, scope: ErasureScope): Promise<ErasureBlocker[]> {
    const blockers: ErasureBlocker[] = [];
    for (const g of ERASURE_HOLDER_GUARDS) {
      const param = g.keyspace === 'tenant' ? tenantId : scope.record_ids;
      const rows = await pg.query<{ n: number | string }>(g.sql, [param]);
      const n = Number(rows.rows[0]?.n ?? 0);
      if (n > 0) blockers.push({ holder: g.holder, classification: g.classification, count: n, reason: g.reason, authority: g.authority });
    }
    return blockers;
  }

  // The id-arrays an INVENTORY WHERE binds: the record set (record / record-child),
  // the sourced-talent set (sourced), or both ($1 records, $2 sourced).
  private keyParams(step: Pick<ErasureStep, 'keyspace'>, scope: ErasureScope): unknown[] {
    if (step.keyspace === 'sourced') return [scope.sourced_talent_ids];
    if (step.keyspace === 'record-or-sourced') return [scope.record_ids, scope.sourced_talent_ids];
    return [scope.record_ids];
  }

  private async findRun(pg: PgExec, tenantId: string, recordId: string): Promise<RunRow | null> {
    const rows = await pg.query<RunRow>(
      `SELECT id, state, record_ids FROM consent."TalentErasureRun" WHERE tenant_id = $1::uuid AND record_id = $2::uuid`,
      [tenantId, recordId],
    );
    return rows.rows[0] ?? null;
  }

  private async storageStatus(pg: PgExec, runId: string | null): Promise<ErasureStorageStatus> {
    if (runId === null) return { total: 0, purged: 0, pending: 0, failed: 0 };
    const rows = await pg.query<{ state: string; n: number | string }>(
      `SELECT state, count(*)::int AS n FROM consent."TalentErasureArtifact" WHERE run_id = $1::uuid GROUP BY state`,
      [runId],
    );
    const by = (st: string) => Number(rows.rows.find((r) => r.state === st)?.n ?? 0);
    return { total: by('PURGED') + by('PENDING') + by('FAILED'), purged: by('PURGED'), pending: by('PENDING'), failed: by('FAILED') };
  }

  private async markerExists(pg: PgExec, tenantId: string, recordId: string): Promise<boolean> {
    const already = await pg.query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM audit."ConsentAuditEvent"
       WHERE tenant_id = $1::uuid AND subject_id = $2::uuid AND event_type = 'consent.erased'`,
      [tenantId, recordId],
    );
    return Number(already.rows[0]?.n ?? 0) > 0;
  }

  // The retained consent erasure marker (what is_anonymized reads). Appended ONLY
  // when the run is COMPLETED, inside the transaction that completes it.
  private async appendMarker(pg: PgExec, tenantId: string, recordId: string, payload: Record<string, unknown>): Promise<boolean> {
    if (await this.markerExists(pg, tenantId, recordId)) return false;
    await pg.query(
      `INSERT INTO audit."ConsentAuditEvent" (id, tenant_id, actor_id, actor_type, event_type, subject_id, event_payload, created_at)
       VALUES (gen_random_uuid(), $1::uuid, NULL, 'system', 'consent.erased', $2::uuid, $3::jsonb, now())`,
      [tenantId, recordId, JSON.stringify(payload)],
    );
    return true;
  }

  private base(tenantId: string, recordId: string, mode: ErasureReport['mode'], scope: ErasureScope): ErasureReport {
    return {
      tenant_id: tenantId,
      record_id: recordId,
      mode,
      outcome: 'FAILED',
      blockers: [],
      run_id: null,
      scope,
      steps: [],
      retained: [...RETAINED],
      storage: { total: 0, purged: 0, pending: 0, failed: 0 },
      erasure_marker_appended: false,
      is_anonymized_flipped: false,
      total_rows: 0,
      redacted_rows: 0,
    };
  }

  async dryRun(pg: PgExec, tenantId: string, recordId: string): Promise<ErasureReport> {
    const scope = await this.resolveScope(pg, tenantId, recordId);
    const report = this.base(tenantId, recordId, 'dry-run', scope);
    report.outcome = 'DRY_RUN';
    report.blockers = await this.preflight(pg, tenantId, scope);
    for (const r of REDACTIONS) {
      const rows = await pg.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${r.label} WHERE ${r.where}`, [scope.record_ids]);
      const n = Number(rows.rows[0]?.n ?? 0);
      report.redacted_rows += n;
      report.steps.push({ table: r.label, count: n, status: 'counted' });
    }
    for (const t of TOMBSTONES) {
      const where = t.label === 'client_selection."ClientSelectionProcess"' ? 'talent_id = ANY($1::uuid[])' : 'talent_record_id = ANY($1::uuid[])';
      const rows = await pg.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${t.label} WHERE ${where}`, [scope.record_ids]);
      const n = Number(rows.rows[0]?.n ?? 0);
      report.redacted_rows += n;
      report.steps.push({ table: t.label, count: n, status: 'counted' });
    }
    for (const step of INVENTORY) {
      try {
        const rows = await pg.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM ${step.label} WHERE ${step.where}`,
          this.keyParams(step, scope),
        );
        const n = Number(rows.rows[0]?.n ?? 0);
        report.total_rows += n;
        report.steps.push({ table: step.label, count: n, status: 'counted' });
      } catch (err) {
        report.steps.push({ table: step.label, count: 0, status: 'failed', error: msg(err) });
      }
    }
    report.storage.total = scope.s3_keys.length;
    report.storage.pending = scope.s3_keys.length;
    return report;
  }

  // The live pass (S2): preflight → ONE database transaction → durable storage
  // purge → COMPLETED (marker) or STORAGE_PENDING. Idempotent: a COMPLETED run is
  // a no-op; a STORAGE_PENDING run resumes its storage phase.
  async execute(pg: PgExec, tenantId: string, recordId: string, store: ErasureObjectStore): Promise<ErasureReport> {
    const existing = await this.findRun(pg, tenantId, recordId);
    if (existing !== null) return this.resume(pg, tenantId, recordId, store);

    const scope = await this.resolveScope(pg, tenantId, recordId);
    const report = this.base(tenantId, recordId, 'execute', scope);
    const present = await pg.query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM talent_record."TalentRecord" WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, recordId],
    );
    if (Number(present.rows[0]?.n ?? 0) === 0) {
      report.failure = 'record_not_found: no TalentRecord with this id in this tenant (and no erasure run exists)';
      return report;
    }
    // The preflight runs INSIDE the transaction, after the identity locks (below) — the one
    // authoritative check; dryRun runs the same guards read-only.
    const runId = randomUUID();
    let failing: string | null = null;
    await pg.query('BEGIN');
    try {
      // Gate-5 C — serialize with every concurrent writer BEFORE checking anything. Talent-
      // keyed writes take a SHARED advisory lock on the talent (consent write-guard
      // triggers); the pass takes the EXCLUSIVE lock on every record of the husk chain and on
      // each of the talent's contact values (read before any delete). A writer that started
      // first makes this wait, and its committed row is then seen below; a writer that
      // arrives now waits, and once the run commits it is refused (the record is erased).
      failing = 'identity locks';
      await pg.query(`SELECT consent.s2_lock_talent_identity($1::uuid[])`, [scope.record_ids]);
      // FK-checked children (status history, dispositions, note events, document events,
      // screening and conversation rows) take a KEY SHARE lock on their parent: locking the
      // parents FOR UPDATE makes a concurrent child insert wait for this pass.
      failing = 'parent row locks';
      for (const lock of PARENT_LOCKS) await pg.query(lock.sql, this.keyParams(lock, scope));
      // S2 LOCKED §2 — open the run through the SECURITY DEFINER entry point. It creates the
      // DB_PASS_IN_PROGRESS run in THIS transaction and arms it; the record set it authorizes
      // is computed by the database (the husk chain), so it must equal the resolved scope.
      // ATI-SEP-1 T10 WP4 — the run's subject_ids (retired trust subjects) is always empty.
      failing = 'erasure run authorization';
      const opened = await pg.query<{ ids: string[] }>(
        `SELECT consent.s2_begin_talent_erasure_run($1::uuid, $2::uuid, $3::uuid, $4::uuid[]) AS ids`,
        [runId, tenantId, recordId, []],
      );
      const authorized = [...(opened.rows[0]?.ids ?? [])].sort();
      if (authorized.join(',') !== [...scope.record_ids].sort().join(',')) {
        throw new Error('the database-authorized record set differs from the resolved scope');
      }
      // The authoritative preflight: under the locks, every committed holder is visible and
      // no new one can be written until this transaction ends. Blocked → roll back.
      failing = 'preflight';
      const blockers = await this.preflight(pg, tenantId, scope);
      if (blockers.length > 0) throw new ErasureBlockedError(blockers);
      // Re-collect the keys inside the transaction (the same snapshot the deletes see).
      const keys = await this.collectStorageKeys(pg, scope);
      scope.s3_keys = keys;
      // §3.2 / §3.3 redactions first — each trigger resolves the talent through the parent.
      for (const r of REDACTIONS) {
        failing = r.label;
        const res = await pg.query(`UPDATE ${r.label} SET ${r.set} WHERE ${r.where}`, [scope.record_ids]);
        const n = res.rowCount ?? 0;
        report.redacted_rows += n;
        report.steps.push({ table: r.label, count: n, status: 'redacted' });
      }
      for (const step of INVENTORY) {
        failing = step.label;
        const res = await pg.query(`DELETE FROM ${step.label} WHERE ${step.where}`, this.keyParams(step, scope));
        const n = res.rowCount ?? 0;
        report.total_rows += n;
        report.steps.push({ table: step.label, count: n, status: 'deleted' });
      }
      // §3.2 — ONE fresh tombstone per (record, requisition): transaction-local, dropped at
      // COMMIT or ROLLBACK, never derived from the id and never written to the ledger.
      failing = 'tombstones';
      await pg.query(`DROP TABLE IF EXISTS pg_temp.s2_erasure_tombstone`);
      await pg.query(
        `CREATE TEMP TABLE s2_erasure_tombstone ON COMMIT DROP AS
           SELECT k.record_id, k.requisition_id, gen_random_uuid() AS tombstone FROM (${TOMBSTONE_KEYS}) k`,
        [scope.record_ids],
      );
      for (const t of TOMBSTONES) {
        failing = t.label;
        const res = await pg.query(t.sql, [scope.record_ids]);
        const n = res.rowCount ?? 0;
        report.redacted_rows += n;
        report.steps.push({ table: t.label, count: n, status: 'tombstoned' });
      }
      // ATI-SEP-1 A3 (Addendum A1 §1) — the business fact, in THIS transaction:
      // one talent.erased per erased record (ids only), so the event exists iff
      // the erasure commits.
      failing = 'talent.erased outbox';
      for (const record_id of scope.record_ids) {
        const ev = buildTalentEventRow({ tenant_id: tenantId, event_type: TALENT_EVENT_ERASED, talent_record_id: record_id, correlation_id: runId });
        await pg.query(
          `INSERT INTO talent_record."TalentEventOutbox" (id, tenant_id, event_type, event_payload, event_version, source, subject_type, subject_id, correlation_id, causation_id)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8::uuid, $9, NULL)`,
          [ev.id, ev.tenant_id, ev.event_type, JSON.stringify(ev.event_payload), ev.event_version, ev.source, ev.subject_type, ev.subject_id, ev.correlation_id],
        );
      }
      failing = 'erasure run record';
      const complete = keys.length === 0;
      // Leave DB_PASS_IN_PROGRESS (a deferred trigger rejects a COMMIT that does not).
      await pg.query(
        `UPDATE consent."TalentErasureRun" SET state = $2, artifact_count = $3, completed_at = ${complete ? 'now()' : 'NULL'}
          WHERE id = $1::uuid AND state = 'DB_PASS_IN_PROGRESS'`,
        [runId, complete ? 'COMPLETED' : 'STORAGE_PENDING', keys.length],
      );
      for (const key of keys) {
        await pg.query(
          `INSERT INTO consent."TalentErasureArtifact" (id, tenant_id, run_id, storage_key, storage_key_sha256, state)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'PENDING')`,
          [randomUUID(), tenantId, runId, key, sha256(key)],
        );
      }
      if (complete) {
        report.erasure_marker_appended = await this.appendMarker(pg, tenantId, recordId, this.markerPayload(runId, scope, report, 0));
      }
      failing = 'commit';
      await pg.query('COMMIT');
    } catch (err) {
      await pg.query('ROLLBACK').catch(() => undefined);
      for (const st of report.steps) st.status = 'rolled_back';
      report.steps.push({ table: failing ?? 'unknown', count: 0, status: 'failed', error: msg(err) });
      report.total_rows = 0;
      report.redacted_rows = 0;
      if (err instanceof ErasureBlockedError) {
        report.outcome = 'BLOCKED';
        report.blockers = err.blockers;
        report.failure = 'preflight: holders that this erasure may not remove are present — nothing was deleted';
        return report;
      }
      report.outcome = 'FAILED';
      report.failure = `database pass rolled back at ${failing ?? 'unknown'} — nothing was deleted`;
      return report;
    }
    report.run_id = runId;
    if (scope.s3_keys.length === 0) {
      report.outcome = 'COMPLETED';
      report.is_anonymized_flipped = true;
      return report;
    }
    return this.storagePhase(pg, report, store);
  }

  // S2 F5 — resume (or re-run) a recorded erasure run: purge every not-yet-purged
  // artifact and complete the run when all are verifiably gone. No DB re-pass.
  async resume(pg: PgExec, tenantId: string, recordId: string, store: ErasureObjectStore): Promise<ErasureReport> {
    const run = await this.findRun(pg, tenantId, recordId);
    const scope: ErasureScope = { record_ids: run?.record_ids ?? [recordId], sourced_talent_ids: [], s3_keys: [] };
    const report = this.base(tenantId, recordId, 'resume', scope);
    if (run === null) {
      report.failure = 'no_erasure_run: run erase-talent --execute first';
      return report;
    }
    report.run_id = run.id;
    if (run.state === 'COMPLETED') {
      report.outcome = 'COMPLETED';
      report.storage = await this.storageStatus(pg, run.id);
      report.is_anonymized_flipped = await this.markerExists(pg, tenantId, recordId);
      return report;
    }
    return this.storagePhase(pg, report, store);
  }

  private async storagePhase(pg: PgExec, report: ErasureReport, store: ErasureObjectStore): Promise<ErasureReport> {
    const runId = report.run_id as string;
    const pending = await pg.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM consent."TalentErasureArtifact" WHERE run_id = $1::uuid AND state <> 'PURGED' ORDER BY storage_key_sha256`,
      [runId],
    );
    for (const a of pending.rows) {
      let error: string | null = null;
      try {
        const r = await store.purge(a.storage_key);
        if (r.remaining > 0) error = `${r.remaining} version(s) remain after purge`;
      } catch (err) {
        // Never persist the key (it can carry PII) inside the error text.
        error = msg(err).split(a.storage_key).join('<key>').slice(0, 500);
      }
      if (error === null) {
        await pg.query(
          `UPDATE consent."TalentErasureArtifact" SET state = 'PURGED', storage_key = NULL, purged_at = now(),
             last_error = NULL, attempt_count = attempt_count + 1, last_attempt_at = now() WHERE id = $1::uuid`,
          [a.id],
        );
      } else {
        await pg.query(
          `UPDATE consent."TalentErasureArtifact" SET state = 'FAILED', last_error = $2,
             attempt_count = attempt_count + 1, last_attempt_at = now() WHERE id = $1::uuid`,
          [a.id, error],
        );
      }
    }
    await pg.query(
      `UPDATE consent."TalentErasureRun" SET attempt_count = attempt_count + 1, last_attempt_at = now() WHERE id = $1::uuid`,
      [runId],
    );
    report.storage = await this.storageStatus(pg, runId);
    if (report.storage.purged < report.storage.total) {
      report.outcome = 'STORAGE_PENDING';
      report.failure = `${report.storage.total - report.storage.purged} object-storage artifact(s) not yet verifiably purged — re-run with --resume`;
      return report;
    }
    // Every artifact purged → complete the run and append the marker atomically.
    await pg.query('BEGIN');
    try {
      await pg.query(
        `UPDATE consent."TalentErasureRun" SET state = 'COMPLETED', completed_at = now() WHERE id = $1::uuid AND state = 'STORAGE_PENDING'`,
        [runId],
      );
      report.erasure_marker_appended = await this.appendMarker(
        pg,
        report.tenant_id,
        report.record_id,
        this.markerPayload(runId, report.scope, report, report.storage.purged),
      );
      await pg.query('COMMIT');
    } catch (err) {
      await pg.query('ROLLBACK').catch(() => undefined);
      report.outcome = 'STORAGE_PENDING';
      report.failure = `completion failed (${msg(err)}) — re-run with --resume`;
      return report;
    }
    report.outcome = 'COMPLETED';
    report.is_anonymized_flipped = true;
    return report;
  }

  private markerPayload(runId: string, scope: ErasureScope, report: ErasureReport, purged: number): Record<string, unknown> {
    return {
      run_id: runId,
      record_ids: scope.record_ids,
      sourced_talent_ids: scope.sourced_talent_ids,
      tables_cleared: report.steps.filter((s) => s.status === 'deleted').map((s) => s.table),
      tables_redacted: report.steps.filter((s) => s.status === 'redacted' || s.status === 'tombstoned').map((s) => s.table),
      artifacts_purged: purged,
    };
  }
}

class ErasureBlockedError extends Error {
  constructor(readonly blockers: ErasureBlocker[]) {
    super('erasure blocked inside the database pass');
  }
}

function sha256(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
