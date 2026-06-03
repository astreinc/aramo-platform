import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import {
  CommonModule,
  CrossSchemaConsistencyModule,
  RequestIdMiddleware,
} from '@aramo/common';
import { ActivityModule } from '@aramo/activity';
import { AttachmentModule } from '@aramo/attachment';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CalendarModule } from '@aramo/calendar';
import { CompanyModule } from '@aramo/company';
import { ConsentModule } from '@aramo/consent';
import { ContactModule } from '@aramo/contact';
import { EngagementModule } from '@aramo/engagement';
import { EntitlementModule } from '@aramo/entitlement';
import { ExportModule } from '@aramo/export';
import { ImportModule } from '@aramo/import';
import { IngestionModule } from '@aramo/ingestion';
import { MatchingModule } from '@aramo/matching';
import { OutboxPublisherModule } from '@aramo/outbox-publisher';
import { PipelineModule } from '@aramo/pipeline';
import { PortalModule } from '@aramo/portal';
import { ReportingModule } from '@aramo/reporting';
import { RequisitionModule } from '@aramo/requisition';
import { SavedListModule } from '@aramo/saved-list';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';
import { SubmittalModule } from '@aramo/submittal';
import { TalentRecordModule } from '@aramo/talent-record';

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
    // M6 PR-2 §4 — OutboxPublisherModule (new leaf lib). Hosts the
    // relocated outbox-publisher BullMQ queue + processor; drains
    // consent + engagement + submittal OutboxEvent tables. Imported
    // here (and only here) — leaf lib, leaf import.
    OutboxPublisherModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // PR-2 precedent: RequestIdMiddleware applies to every route. Future
    // PRs do not need to re-wire it for new endpoints.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
