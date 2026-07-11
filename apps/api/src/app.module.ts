import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  CommonModule,
  CrossSchemaConsistencyModule,
  RequestIdMiddleware,
} from '@aramo/common';
import { VisibilityInterceptor, VisibilityModule } from '@aramo/visibility';
import { ActivityModule } from '@aramo/activity';
import { AttachmentModule } from '@aramo/attachment';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CalendarModule } from '@aramo/calendar';
import { CanonicalizationModule } from '@aramo/canonicalization';
import { ColdIngestExtractionModule } from '@aramo/cold-ingest-extraction';
import { TalentReconcileModule } from '@aramo/talent-reconcile';
import { CompanyModule } from '@aramo/company';
import { ConsentModule } from '@aramo/consent';
import { ContactModule } from '@aramo/contact';
import { EngagementModule } from '@aramo/engagement';
import { EntitlementModule } from '@aramo/entitlement';
import { ExportModule } from '@aramo/export';
import { IdentityModule, IdentityCoreModule } from '@aramo/identity';
import { ImportModule } from '@aramo/import';
import { IngestionModule } from '@aramo/ingestion';
import { JobDomainModule } from '@aramo/job-domain';
import { MailerModule } from '@aramo/mailer';
import { MatchingModule } from '@aramo/matching';
import { ObjectStorageModule } from '@aramo/object-storage';
import { OutboxPublisherModule } from '@aramo/outbox-publisher';
import { PipelineModule } from '@aramo/pipeline';
import { PortalModule } from '@aramo/portal';
import { ReportingModule } from '@aramo/reporting';
import { RequisitionModule } from '@aramo/requisition';
import { SavedListModule } from '@aramo/saved-list';
import { SettingsModule } from '@aramo/settings';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';
import { SubmittalModule } from '@aramo/submittal';
// TR-2a-B3b — EvidenceModule + ExaminationModule imported so the record-reconcile
// orchestrator can inject EvidenceRepository + ExaminationRepository (both were
// only transitive deps of apps/api before this slice).
import { EvidenceModule } from '@aramo/evidence';
import { ExaminationModule } from '@aramo/examination';
import { TalentEvidenceModule } from '@aramo/talent-evidence';
import { TalentExtractionModule } from '@aramo/talent-extraction';
import { TalentRecordModule, ResumeReindexModule } from '@aramo/talent-record';
import { TalentTrustModule } from '@aramo/talent-trust';
import { TaskModule } from '@aramo/task';

import { TenantCognitoAdapter } from './cognito/tenant-cognito.adapter.js';
import { TalentAnchorInterceptor } from './talent-anchor/talent-anchor.interceptor.js';
import { TalentAnchorProducerService } from './talent-anchor/talent-anchor-producer.service.js';
import { AdvisoryResolutionController } from './talent-identity/advisory-resolution.controller.js';
import { ContradictionResolutionController } from './talent-identity/contradiction-resolution.controller.js';
import { DisputeResolutionController } from './talent-identity/dispute-resolution.controller.js';
import { EmailVerificationController } from './talent-identity/email-verification.controller.js';
import { EmailVerificationService } from './talent-identity/email-verification.service.js';
import {
  PublicVerificationController,
  VerificationConfirmBudget,
} from './controllers/public-verification.controller.js';
import { PromotionService } from './talent-identity/promotion.service.js';
import { RecordReconcileOrchestrator } from './talent-identity/record-reconcile.orchestrator.js';
import { IdentityMaintenanceModule } from './jobs/identity-maintenance.module.js';
import { SourcingController } from './talent-identity/sourcing.controller.js';
import { DossierController } from './talent-identity/dossier.controller.js';
import { VerificationProposalController } from './talent-identity/verification-proposal.controller.js';
import { SourcingService } from './talent-identity/sourcing.service.js';
import { DossierService } from './talent-identity/dossier.service.js';
import { ExamineController } from './controllers/examine.controller.js';
import { TenantSettingsController } from './controllers/tenant-settings.controller.js';
import { AssignableUsersController } from './controllers/assignable-users.controller.js';
import { MeController } from './controllers/me.controller.js';
import { PublicInvitationController } from './controllers/public-invitation.controller.js';
import { PublicTenantCertController } from './controllers/public-tenant-cert.controller.js';
import { CompensationFieldMaskInterceptor } from './interceptors/compensation-field-mask.interceptor.js';
import { TalentRecordEnrichmentInterceptor } from './talent-enrichment/talent-record-enrichment.interceptor.js';
import { TalentRecordEnrichmentService } from './talent-enrichment/talent-record-enrichment.service.js';
import { TalentPresetInterceptor } from './talent-enrichment/talent-preset.interceptor.js';
import { TalentPresetResolverService } from './talent-enrichment/talent-preset-resolver.service.js';
// Settings S4 — live AUDIT_FINANCIALS_GATE adapter (reads via
// TenantSettingService; bridges libs/identity's port to libs/settings'
// service without coupling either lib).
import { AuditFinancialsGateAdapter } from './settings/audit-financials-gate.adapter.js';
// Tasks backend — live TASK_ASSIGNEE_VALIDATOR adapter (validates an
// assignee is an active within-tenant member via IdentityService).
import { TaskAssigneeAdapter } from './tasks/task-assignee.adapter.js';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    // PR-A1a §3 — AuthorizationModule provides RolesGuard for the
    // @RequireScopes / @RequireSiteMatch decorators applied to
    // controllers. Leaf lib: depends only on @aramo/auth and
    // @aramo/common; no domain-lib back-edge.
    AuthorizationModule,
    // PR-A1b §2 — EntitlementModule provides EntitlementGuard for the
    // @RequireCapability decorator applied to controllers. Tenant-axis
    // gate (distinct from RolesGuard scope-axis per Ruling 1); runs
    // BEFORE RolesGuard via @UseGuards(JwtAuthGuard, EntitlementGuard,
    // RolesGuard). Leaf lib: depends only on @aramo/auth and @aramo/common.
    EntitlementModule,
    // PR-A2 Gate 5 — first ATS-domain reference-data leaves. CompanyModule
    // is imported BEFORE ContactModule because ContactModule depends on it
    // (the contact -> company leaf edge; CompanyRepository is injected
    // into ContactRepository for cross-schema tenant-scoped company_id
    // validation). The reverse direction is UUID-only at read time, so
    // CompanyModule does NOT import ContactModule — no cycle.
    CompanyModule,
    ContactModule,
    ConsentModule,
    // M5 PR-11 Gate 5-redux (Option β-1 / PL-88) — CrossSchemaConsistencyModule
    // is imported here directly (NOT via CommonModule) so its BullMQ Worker
    // is only instantiated in graphs that need it. AuthServiceModule
    // (pact provider) imports CommonModule but NOT this module, so its
    // pact-provider boot stays BullMQ-Worker-free.
    CrossSchemaConsistencyModule,
    EngagementModule,
    IngestionModule,
    MatchingModule,
    // Gate-1 G1-B — the examine endpoint's derivation reads GoldenProfile
    // (JobDomainModule), declared skill evidence (TalentEvidenceModule), and
    // lazily runs extraction (TalentExtractionModule). Composition-root imports
    // — no lib→lib edge, no cycle.
    JobDomainModule,
    TalentEvidenceModule,
    TalentExtractionModule,
    // TR-2a-1 — the anchor producer (apps/api, above the I15 wall) records
    // TalentRecord identifier anchors into the trust ledger. TalentTrustModule
    // provides TalentTrustService; TalentRecordModule (above) provides the
    // repository the producer reads. Composition-root wiring — talent_trust
    // (cip) never imports talent-record (ats).
    TalentTrustModule,
    // TR-3 B2 — the email-verification flow's mailer edge. apps/api →
    // @aramo/mailer is a NEW direct edge (previously only IdentityModule imported
    // MailerModule, in its own scope). MailerModule is a pure static leaf (no
    // forRoot) so MAILER_PORT binds once and EmailVerificationService resolves it.
    MailerModule,
    PortalModule,
    // PR-A3 Gate 5 — second ATS-domain leaf. RequisitionModule carries
    // the requisition CRUD + the assignment-visibility filter (Ruling 2:
    // a query predicate, not a guard rejection — recruiters see only
    // their assigned reqs; tenant_admin with `requisition:read:all` sees
    // all). Leaf import set: AuthModule + AuthorizationModule +
    // EntitlementModule only (no @aramo/company / @aramo/contact).
    RequisitionModule,
    // PR-A4 Gate 5 — third ATS-domain batch: talent-record + attachment.
    // TalentRecordModule is imported BEFORE AttachmentModule because
    // AttachmentModule depends on it (attachment -> talent-record edge;
    // TalentRecordRepository is injected into AttachmentRepository for
    // service-layer owner validation on the `talent` owner_type path).
    // The reverse direction is UUID-only at the schema level, so
    // TalentRecordModule does NOT import AttachmentModule — no cycle.
    // Renamed from `libs/talent` to avoid collision with the pre-existing
    // Core libs/talent (tenant-AGNOSTIC identity, PR-10 baseline).
    TalentRecordModule,
    AttachmentModule,
    // Tasks backend — the last core recruiter surface (the actionable,
    // due-dated, assignable to-do).
    //
    // Task-Assignee Binding-Fix v1.0 — apps/api owns the live
    // IdentityService-backed adapter, so it imports via forRoot, binding
    // TaskAssigneeAdapter to TASK_ASSIGNEE_VALIDATOR inside TaskModule's OWN
    // scope. This is what actually reaches TaskController (the sole consumer);
    // the former AppModule-scoped override (removed below) never did, because
    // NestJS DI is per-module hierarchical and TaskModule is not @Global —
    // so the R5 active-within-tenant assignee check silently accepted ANY
    // assignee (the accept-any stub, a fail-OPEN authz hole).
    //
    // imports: [IdentityCoreModule] threads IdentityService into TaskModule's
    // dynamic scope so TaskAssigneeAdapter (which injects it) can be
    // instantiated there. Unlike the no-arg cognito adapter, this adapter has
    // a Nest dependency; libs/task stays leaf (it never names the module —
    // apps/api passes it through as an opaque module ref).
    //
    // Auth-Hardening IdentityModule-Split v1.0 — threads IdentityCoreModule
    // (the shared read surface), NOT IdentityModule. TaskAssigneeAdapter needs
    // only IdentityService; importing the slim IdentityModule statically here
    // would re-create the second stub-bound instance the split removes (this
    // was one of the three apps/api-graph static importers in the defect).
    TaskModule.forRoot({
      assigneeValidator: TaskAssigneeAdapter,
      imports: [IdentityCoreModule],
    }),
    // Search PR-2 — the résumé re-extract worker. SEPARATE from
    // TalentRecordModule (imported widely) so only apps/api stands up the
    // BullMQ tick worker; AttachmentModule gets ResumeTextService.enqueueReindex
    // via TalentRecordModule WITHOUT the worker. Imported AFTER both, since it
    // depends on TalentRecordModule (ResumeTextService.drainPendingBatch).
    ResumeReindexModule,
    // PR-A5a Gate 5 — fourth ATS-domain batch (part a): pipeline state
    // machine + activity log. ActivityModule is imported BEFORE
    // PipelineModule because PipelineModule depends on it (pipeline ->
    // activity edge; the @aramo/activity insertActivityInTx helper is
    // composed into PipelineRepository.transition's $transaction so the
    // pipeline_status_change Activity row commits atomically with the
    // status update + history + metering event — directive §3 / Ruling 6).
    // The reverse direction never exists: ActivityModule does NOT import
    // PipelineModule (lint:nx-boundaries enforces; one-way edge).
    // A5a is ATS-internal: pipeline reaches `placed` as a status but
    // does NOT decrement requisition.openings or sync submittal — that
    // is A5b.
    ActivityModule,
    PipelineModule,
    // PR-A6 Gate 5+6 (combined) — ATS finishers batch 5: calendar +
    // saved-list. Both are pattern-reuse leaves with NO new design
    // decision (the combined-mode guardrail held — no fork surfaced):
    //   - CalendarModule is STANDALONE (no domain dep). Owner-or-admin
    //     edit/delete predicate (the A3 shape, single-owner field):
    //     recruiter holding `calendar:event-edit` edits OWN events;
    //     actors in the tenant_admin tier (proxy: scopes include
    //     `calendar:event-delete`) edit any. Non-owner recruiter edit
    //     → 404 NOT_FOUND (A3 info-leak-closing precedent).
    //   - SavedListModule depends on {company, contact, requisition,
    //     talent-record} for service-layer owner validation (the A4
    //     attachment shape generalized — all 4 ATS entities are now
    //     live, so all 4 owner paths are wired vs. A4's 1-of-4 stub).
    //     Homogeneity invariant: a SavedList.item_type fixes the type
    //     of all its entries (per-add mismatch → 422
    //     SAVED_LIST_ITEM_TYPE_MISMATCH). Static lists only — the
    //     OpenCATS dynamic-list path is dormant (directive §8).
    // None of the 4 entity modules imports SavedListModule — all 4
    // edges are forward; no cycle (lint:nx-boundaries enforces).
    CalendarModule,
    SavedListModule,
    // PR-A7 Gate 5 — ATS-INTERNAL reporting + dashboard read aggregator.
    // Reads ONLY the 8 ATS-side schemas (company / contact / requisition
    // / pipeline / activity / calendar / saved_list / talent_record) +
    // the existing per-module repositories. The dependency closure is
    // the seam-exclusion proof: ReportingModule does NOT import any
    // Core / engagement / submittal / examination / matching / talent /
    // job_domain module. The dashboard's "placement" metric is the
    // ATS-internal placed-pipeline view (A5b-1 terminal state), NOT a
    // Core submittal-confirmed-placement (which would cross the seam;
    // that's T5, judgment-out, M6-gated). Hard exclusions also for
    // EEO reporting (A4-deferred fields don't exist) and PDF rendering
    // (presentation, deferred).
    ReportingModule,
    // PR-A8-4 Gate 5 — ATS-domain CSV export. Reads-only over the 5
    // ATS-domain entities (company / contact / requisition /
    // talent_record / pipeline) — the dependency closure is the R10
    // structural seam-exclusion proof: ExportModule does NOT import
    // any Core / engagement / submittal / examination / matching /
    // talent / job_domain module. The integration spec replays the
    // A7 reporting-service pattern by OMITTING every Core migration
    // from the test container and asserting the export routes still
    // serve 200 (if any Core read existed it would 500). A3-
    // visibility composes inside ExportService — recruiter exports
    // own-assigned requisitions + pipelines (via
    // RequisitionRepository.listForActor + upstream-resolved
    // requisition_ids); tenant_admin exports tenant-wide. The
    // OUTBOUND-VOCABULARY rule: header rows carry canonical Aramo
    // ATS field names; outbound-anti-tokens NEVER appear (the
    // libs/import inbound alias is import-only — see the integration
    // spec OUTBOUND_ANTI_TOKENS list).
    ExportModule,
    // PR-A8-1 Gate 5 — ATS import ENGINE. Audited reversible batches
    // with partial-commit semantics. Imports rows into 4 ATS targets
    // (company / contact / requisition / talent_record) via each
    // target lib's createForImport surface; reverts via the additive
    // import_batch_id back-reference column. THE non-negotiable
    // boundary: this lib does NOT import @aramo/talent (the Core lib)
    // — importing target_entity 'talent_record' creates TalentRecord
    // rows with core_talent_id NULL; canonicalization is M6-owned
    // (T2). The integration spec proves it via bit-identical talent.*
    // row-counts pre/post.
    ImportModule,
    // M5 PR-11 §4.5/§4.6 — SkillsTaxonomyModule registers the
    // skill-canonicalization queue + no-op processor (Architecture v2.1
    // §9.2 / Plan v1.5 §M5 Track A item 6 binding).
    SkillsTaxonomyModule,
    SubmittalModule,
    // TR-2a-B3b — the record-reconcile orchestrator injects EvidenceRepository +
    // ExaminationRepository (both operational holders swept on a both-promoted
    // merge). Their modules export the repos; importing them here makes them
    // available to the orchestrator's DI in app.module.
    EvidenceModule,
    ExaminationModule,
    // T2-2a — canonicalization orchestrator (NEW leaf lib). Lead-authored
    // per Aramo-T2-2a-Canonicalization-Orchestration-Directive-v1_0-LOCKED.md.
    // Service-only at T2-2a (no controller). Imported here BEFORE
    // OutboxPublisherModule so the dependency direction stays forward:
    // canonicalization -> {ingestion, talent, talent_evidence} via Nest
    // module imports + via the multi-schema Prisma follower (Option A,
    // §1 Ruling 1). T2-2b extends OutboxPublisherModule to inject
    // CanonicalizationOutboxRepository and drain the 4th schema; that
    // edge does NOT yet exist at T2-2a (the split seam — events sit
    // unpublished, harmless because no consumer).
    CanonicalizationModule,
    // Cold-Ingest Extraction — the resolved-arrival → declared-identity-evidence
    // poll (NEW leaf lib, scope:cip). Registers a BullMQ tick worker that drains
    // resolved RawPayloadReference rows whose résumé still needs extraction,
    // re-reads the retained résumé with the deterministic parser (no LLM), and
    // writes name/phone/address as THIRD_PARTY_UNVERIFIED declared evidence onto
    // the arrival's resolved_subject_id — unblocking cold-ingest promotion (a
    // TalentRecord needs a name). Consumer leaf: imports {ingestion, resume-parse,
    // talent-trust} (all scope:cip). Placed after CanonicalizationModule so a
    // subject exists before extraction polls it.
    ColdIngestExtractionModule,
    // Promotion Gate Slice-B1 — the reconcile poll (NEW leaf lib, scope:ats).
    // Above the I15 wall: reads the cip trust ledger + writes the ats TalentRecord
    // (enrich fill-null contact + append key_skills) with field→evidence
    // provenance, recording occupied+newer-differing as pending contradictions
    // (B2 acts). OPEN-2: L2 is the retained history, L3 the current projection —
    // no L3 version table. Imports {talent-trust (cip), talent-record (ats)};
    // ats→cip is wall-clean (canonicalization precedent). Placed after the
    // promotion/extraction path so a promoted subject exists before reconcile.
    TalentReconcileModule,
    // TR-6 B1 (DDR §2/§7) — the identity-maintenance jobs: the hourly incremental
    // match sweep (D1) + the daily read-only integrity-detection cron (D6). apps/api
    // boundary layer; imports {talent-trust (cip), talent-record (ats)} — both edges
    // pre-exist. The SCHEDULES registrar (jobs/registration.ts) enqueues its ticks.
    IdentityMaintenanceModule,
    // A8-3a — ObjectStorageModule (new leaf lib). The platform's first
    // live S3 substrate: presigned PUT/GET helpers + tenant-scoped key
    // convention + PII floor (≤ 300s expiry cap + access-log emission).
    // Activates the dormant A4 Attachment.storage_key + M2
    // RawPayloadReference.storage_ref patterns end-to-end. Leaf lib:
    // imports = [] (AramoError + AramoLogger are TS-level imports);
    // exports = [ObjectStorageService] only. Consumers (A8-3b résumé
    // upload; later A4 owner_types) consume ObjectStorageService at
    // the cross-lib boundary.
    ObjectStorageModule,
    // M6 PR-2 §4 — OutboxPublisherModule (new leaf lib). Hosts the
    // relocated outbox-publisher BullMQ queue + processor; drains
    // consent + engagement + submittal OutboxEvent tables. Imported
    // here (and only here) — leaf lib, leaf import.
    OutboxPublisherModule,
    // Settings S2 — IdentityModule provides IdentityAuditService for the
    // app-layer two-call AUDIT SEAM in TenantSettingsController (the PUT
    // /v1/tenant/settings/:key path emits identity.tenant_setting.updated).
    // The seam lives at the controller (NOT inside libs/settings) so the
    // settings lib stays a true LEAF — its only @aramo/* edge is
    // @aramo/common. This mirrors the libs/company → @aramo/identity
    // cross-lib audit-emission edge (the D4a precedent) and D5's field-
    // mask interceptor placement (terminal lib + app-level cross-cutting
    // wire). The shared identity surface (IdentityCoreModule) was already in
    // the apps/api module graph transitively via CompanyModule; the
    // IdentityModule.forRoot import below re-exports it, making
    // IdentityAuditService injectable into TenantSettingsController.
    //
    // Auth-Cognito-Binding-Fix v1.0 — apps/api owns the live Cognito
    // adapter, so it imports via forRoot, binding TenantCognitoAdapter to
    // TENANT_COGNITO_PORT inside IdentityModule's OWN scope. This is what
    // actually reaches TenantUserLifecycleService (the sole consumer); the
    // former AppModule-scoped override (removed below) never did, because
    // NestJS DI is per-module hierarchical and IdentityModule is not @Global.
    //
    // Financials-Gate-Binding-Fix v1.0 — the SAME forRoot now also binds the
    // live AuditFinancialsGateAdapter to AUDIT_FINANCIALS_GATE in-scope (the
    // adjacent constructor param on the SAME consumer). The former
    // AppModule-scoped override (removed below) was the identical ineffective
    // pattern. imports: [SettingsModule] threads TenantSettingService into
    // IdentityModule's dynamic scope so AuditFinancialsGateAdapter (which
    // injects it) can be instantiated there; libs/identity stays leaf (it
    // never names SettingsModule — apps/api passes it through opaquely).
    IdentityModule.forRoot({
      cognitoAdapter: TenantCognitoAdapter,
      auditFinancialsGate: AuditFinancialsGateAdapter,
      imports: [SettingsModule],
    }),
    // Settings S1 — SettingsModule (NEW LEAF lib, depends only on
    // @aramo/common). Tenant-configuration foundation: the TenantSetting
    // model + the read-through TenantSettingService that powers the
    // first consumer of the seeded `tenant:admin:settings` scope. S2
    // lights up the first KNOWN_SETTINGS key (compensation.display_default)
    // + the write path (set<K> + per-key validator + PUT /v1/tenant/
    // settings/:key). The TenantSettingsController (apps/api/src/
    // controllers/) wires both verbs to the service; the controller lives
    // in apps/api so libs/settings stays a true leaf (the guard-chain
    // dependencies on auth/authorization/entitlement AND the IdentityAudit
    // edge live at the application boundary).
    SettingsModule,
    // AUTHZ-D4b Gate 6 — VisibilityModule. The terminal lib that hosts
    // the composed visibility resolver (Amendment v1.1 §4.3 — direct ∪
    // transitive-reports[depth-3] ∪ pod-clients ∪ [ALL if
    // company:read:all]) + VisibilityInterceptor (global, lazy +
    // memoized per request). NO entity lib imports @aramo/visibility
    // (the Gate-5 Ruling 1 cycle-avoidance discipline — the 6 entity
    // libs receive the resolved VisibilityContext as a parameter,
    // typed via a structural shape declared in @aramo/common). Imported
    // here AFTER every entity module so the resolver's dependencies
    // (identity / company / requisition / pipeline) are fully wired
    // before its providers are constructed.
    VisibilityModule,
  ],
  controllers: [
    // Settings S1 — the GET /v1/tenant/settings endpoint (the seeded
    // `tenant:admin:settings` scope's first consumer). Implicit-tenant
    // from AuthContext; per-tenant isolation via WHERE tenant_id in the
    // repository. Lives here (not in libs/settings) to preserve the
    // leaf-lib invariant on the new lib.
    TenantSettingsController,
    // Gate-1 G1-B — POST /v1/examinations pairing-level examine (mint-only).
    // Lives here (not a lib) because it composes requisition + job-domain +
    // talent-record + talent-evidence + talent-extraction + matching at the
    // app boundary (the deterministic cross-schema derivation).
    ExamineController,
    // §5 Auth-Hardening D4 — the recruiter assignable-roster endpoint. Lives
    // here (not libs/identity) because it composes identity (active+role) with
    // the company schema's user↔client mapping — a cross-schema join wired at
    // the app boundary (CompanyModule + IdentityModule both in this graph).
    AssignableUsersController,
    // Aramo-Identity-Me-Endpoint — GET /v1/me, the self-read display companion
    // to the lean session JWT (name + email + role display names + tenant org
    // label). Lives here (not libs/identity, not auth-service) as a plain
    // tenant read composed on IdentityService — it never touches the token
    // surface (reads only; the session DTO stays frozen at 6 fields).
    MeController,
    // Invite-S2 (Pattern-2) — the PUBLIC (un-guarded) invitation-acceptance
    // endpoint (POST /v1/invitations/accept). No JwtAuthGuard — the invitee
    // has no session yet; authority is the single-use token in the body.
    // Delegates to InvitationLifecycleService (exported by IdentityModule).
    PublicInvitationController,
    // Subdomain-Identity Directive A — the PUBLIC (un-guarded) cert-eligibility
    // ask-endpoint (GET /v1/tenants/cert-eligible?domain=). Caddy's on-demand
    // TLS calls it before issuing a per-host cert; 200 iff a real active tenant
    // owns the host's slug, 404 otherwise. No JwtAuthGuard — Caddy calls it
    // pre-TLS, before any session exists. Delegates to TenantService.
    PublicTenantCertController,
    // TR-2a-3 — the privileged advisory-resolution surface (approve-merge /
    // dismiss / reverse / list). Lives here (not libs/talent-trust) because it is
    // the composition-root HTTP edge ABOVE the I15 wall calling the cip resolution
    // service; gated by the tenant-scoped identity:resolve scope (admin tier).
    AdvisoryResolutionController,
    // TR-4 B3 — the privileged resolve-contradiction surface (identity:resolve).
    // The one human arm on the contradiction machinery the detectors feed.
    ContradictionResolutionController,
    DisputeResolutionController,
    // TR-12 B1 (DDR §4) — the caseworker's worklist surface (list OPEN proposals /
    // dismiss). Reads at talent:read (capability ats — the dossier precedent); it
    // executes nothing (no ACT endpoint this slice — propose-never-dispose).
    VerificationProposalController,
    // Promotion-Trigger slice-A — the sourcer's two triggers (Add to Pipeline /
    // Save to Pool). Both promote a sourced L2 subject → ATS TalentRecord behind
    // the identity gate, then associate. Gated on the talent:source scope.
    SourcingController,
    DossierController,
    // TR-3 B2 — the AUTHENTICATED email-verification surface (request + status)
    // nested under the talent-record resource. Composes talent-record + consent +
    // trust ledger + mailer at the app boundary (above the I15 wall).
    EmailVerificationController,
    // TR-3 B2 — the PUBLIC (un-guarded) confirm endpoint (POST
    // /v1/email-verifications/confirm). No JwtAuthGuard — the talent has no
    // session; authority is the single-use token. Oracle-resistant (§3.2).
    PublicVerificationController,
  ],
  providers: [
    // AUTHZ-D4b Gate 6 — register the VisibilityInterceptor as a global
    // interceptor (APP_INTERCEPTOR). Runs after JwtAuthGuard so the
    // AuthContext is available on the request when the interceptor
    // attaches the lazy resolveVisibility() / resolveVisibleRequisitionIds()
    // / resolveVisiblePipelineIds() functions.
    {
      provide: APP_INTERCEPTOR,
      useClass: VisibilityInterceptor,
    },
    // AUTHZ-D5 — register the CompensationFieldMaskInterceptor as a
    // global interceptor. Shape-1 mirror of VisibilityInterceptor: runs
    // AFTER controller methods complete, walks the response value, and
    // omits comp fields the actor's compensation:view:* scopes don't
    // grant (delegates to libs/field-masking — a NEW terminal lib).
    // D4b masked WHICH RECORDS the actor sees; D5 masks WHICH FIELDS on
    // those records — the two compose. The interceptor lives here (not
    // in the terminal lib) per the D5 commit plan §1.
    {
      provide: APP_INTERCEPTOR,
      useClass: CompensationFieldMaskInterceptor,
    },
    // Segment 3 — the talent-records list read-composer. The composer service
    // is a provider (injects the three read-only batch accessors); the
    // interceptor (global, route-guarded) enriches GET /v1/talent-records
    // responses with last_activity_at / consent_summary / current_stage.
    // Registered AFTER VisibilityInterceptor so resolveVisibleRequisitionIds
    // is set when the response is shaped.
    TalentRecordEnrichmentService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TalentRecordEnrichmentInterceptor,
    },
    // TR-2a-1 — the write-time anchor hook. Global APP_INTERCEPTOR route-guarded
    // to the talent-record WRITE routes (POST /v1/talent-records, PATCH :id);
    // on success it records the record's identifier anchors into the trust
    // ledger via the producer. apps/api orchestration above the I15 wall — the
    // lib controller is untouched, best-effort (never fails the write; the
    // backfill reconciles).
    TalentAnchorProducerService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TalentAnchorInterceptor,
    },
    // Promotion Gate — Slice A (create branch). apps/api orchestration above the
    // I15 wall: PromotionService.promoteSubject reads the cip trust ledger +
    // ingestion arrival and writes the ats TalentRecord + consent event, linking
    // a cold-ingest ResolutionSubject (L2) to a freshly-minted TalentRecord (L3).
    // Provider-only (no HTTP surface — the auto-trigger policy is deferred to a
    // later slice); the deps (TalentTrustService, TalentRecordRepository,
    // SourceConsentService, IngestionRepository) come from their already-imported
    // modules.
    PromotionService,
    // TR-2a-B3b (DDR-3 §1) — the record-reconcile orchestrator (phase 2 of a
    // merge). apps/api boundary layer above the I15 wall; composes the cip
    // trust-side (SubjectMergeOperation, ref normalization, recompute) + each ATS
    // domain's OWN repointTalentRecordRefs. talent_trust imports NO ats. All deps
    // resolve via already-imported modules.
    RecordReconcileOrchestrator,
    // Promotion-Trigger slice-A — the sourcing trigger orchestrator (deps
    // PromotionService + PipelineRepository + SavedListRepository resolve via
    // their already-imported modules).
    SourcingService,
    DossierService,
    // TR-3 B2 — the email-verification request orchestrator (deps
    // TalentRecordRepository + TalentTrustRepository + TalentTrustService +
    // ConsentService + MAILER_PORT resolve via their already-imported modules).
    EmailVerificationService,
    // TR-3 B2 — the public confirm route's per-IP fixed-window budget (a shared
    // singleton the PublicVerificationController injects).
    VerificationConfirmBudget,
    // Segment 4c — Views presets + "My team" scope. The resolver injects the
    // four read-only cross-schema accessors (activity / pipeline / tasks /
    // teams); the interceptor (global, PRE-handler, route-guarded to the paged
    // talent-records list) resolves the preset/scope id sets and stashes them on
    // the request so the lib controller folds them into the native query via the
    // 4a id_allowlist / owner_id hooks. The lib stays single-schema.
    TalentPresetResolverService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TalentPresetInterceptor,
    },
    // Settings S3a — the live AWS-SDK-backed TenantCognitoAdapter is now
    // bound to TENANT_COGNITO_PORT via IdentityModule.forRoot above (in
    // IdentityModule's own scope, the only scope the consumer resolves
    // from). The former AppModule-scoped binding here was ineffective —
    // per-module hierarchical DI never propagated it to the consumer —
    // and is removed (Auth-Cognito-Binding-Fix v1.0). Integration tests
    // still override at the TestingModule level via
    // overrideProvider(TENANT_COGNITO_PORT).
    //
    // Settings S4 — the live TenantSettingService-backed
    // AuditFinancialsGateAdapter is now bound to AUDIT_FINANCIALS_GATE via
    // IdentityModule.forRoot above (in IdentityModule's own scope, the only
    // scope TenantUserLifecycleService.assignTenantUserRoles resolves the
    // GATE from). The former AppModule-scoped binding here was ineffective —
    // per-module hierarchical DI never propagated it to the consumer, so the
    // throw-on-call stub stayed live (the grant failed CLOSED) — and is
    // removed (Financials-Gate-Binding-Fix v1.0). The adapter is instantiated
    // by forRoot's useClass binding; SettingsModule is threaded into
    // IdentityModule's scope there for TenantSettingService injection.
    // Integration tests still override at the TestingModule level via
    // overrideProvider(AUDIT_FINANCIALS_GATE).
    //
    // Tasks backend — the live IdentityService-backed TaskAssigneeAdapter is
    // now bound to TASK_ASSIGNEE_VALIDATOR via TaskModule.forRoot above (in
    // TaskModule's own scope, the only scope TaskController resolves from).
    // The former AppModule-scoped binding here was ineffective — per-module
    // hierarchical DI never propagated it to the consumer, so the accept-any
    // stub stayed live (a fail-OPEN authz hole) — and is removed
    // (Task-Assignee Binding-Fix v1.0). TaskAssigneeAdapter is instantiated
    // by forRoot's useClass binding; IdentityModule is threaded into
    // TaskModule's scope there for IdentityService injection.
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // PR-2 precedent: RequestIdMiddleware applies to every route. Future
    // PRs do not need to re-wire it for new endpoints.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
