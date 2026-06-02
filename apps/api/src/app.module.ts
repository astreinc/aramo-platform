import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import {
  CommonModule,
  CrossSchemaConsistencyModule,
  RequestIdMiddleware,
} from '@aramo/common';
import { AttachmentModule } from '@aramo/attachment';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CompanyModule } from '@aramo/company';
import { ConsentModule } from '@aramo/consent';
import { ContactModule } from '@aramo/contact';
import { EngagementModule } from '@aramo/engagement';
import { EntitlementModule } from '@aramo/entitlement';
import { IngestionModule } from '@aramo/ingestion';
import { MatchingModule } from '@aramo/matching';
import { OutboxPublisherModule } from '@aramo/outbox-publisher';
import { PortalModule } from '@aramo/portal';
import { RequisitionModule } from '@aramo/requisition';
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
