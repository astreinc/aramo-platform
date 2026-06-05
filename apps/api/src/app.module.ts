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
import { CompanyModule } from '@aramo/company';
import { ConsentModule } from '@aramo/consent';
import { ContactModule } from '@aramo/contact';
import { EngagementModule } from '@aramo/engagement';
import { EntitlementModule } from '@aramo/entitlement';
import { ExportModule } from '@aramo/export';
import { ImportModule } from '@aramo/import';
import { IngestionModule } from '@aramo/ingestion';
import { MatchingModule } from '@aramo/matching';
import { ObjectStorageModule } from '@aramo/object-storage';
import { OutboxPublisherModule } from '@aramo/outbox-publisher';
import { PipelineModule } from '@aramo/pipeline';
import { PortalModule } from '@aramo/portal';
import { ReportingModule } from '@aramo/reporting';
import { RequisitionModule } from '@aramo/requisition';
import { SavedListModule } from '@aramo/saved-list';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';
import { SubmittalModule } from '@aramo/submittal';
import { TalentRecordModule } from '@aramo/talent-record';

import { CompensationFieldMaskInterceptor } from './interceptors/compensation-field-mask.interceptor.js';

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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // PR-2 precedent: RequestIdMiddleware applies to every route. Future
    // PRs do not need to re-wire it for new endpoints.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
