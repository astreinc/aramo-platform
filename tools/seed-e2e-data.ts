// Non-interactive seeder for the e2e recruiter's VISIBLE assigned data (Step 6).
//
// Reuses the apps/api AppModule wiring (the exact graph the running API uses)
// and `get`s the real repositories, then calls the SAME create methods the
// controllers call — real domain path, all invariants, NO raw INSERTs. Each
// requisition is explicitly assigned to the test recruiter (RequisitionAssignment)
// so a requisition:read-only recruiter can see it (D4b). Pipeline stages are
// reached by walking the legal state machine via real transitions.
//
// RUN (local stack only; env loaded; symlinks present):
//   set -a && source .env && set +a
//   node --import jiti/register tools/seed-e2e-data.ts \
//     --tenant <TARGET_TENANT_ID> --recruiter-user-id <USER_ID_FROM_PROVISIONING> [--tag 'E2E ']
//
// Inputs come from the provisioning run (user_id) + the PO (tenant). Idempotent
// + tagged (default 'E2E '): a prior tagged requisition short-circuits.
//
// FIRST-RUN VALIDATION: the adapter method names/shapes flagged `VALIDATE`
// below are bound against the live build on the first real run (I cannot
// execute it without the tenant + recruiter id). The orchestration contract
// (seed-e2e-data.lib.ts) is spec-proven.

import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import {
  CompanyRepository,
} from '@aramo/company';
import { ContactRepository } from '@aramo/contact';
import { TalentRecordRepository } from '@aramo/talent-record';
import {
  RequisitionRepository,
  RequisitionAssignmentRepository,
  RequisitionPrismaService,
} from '@aramo/requisition';
import { PipelineRepository } from '@aramo/pipeline';
import { ActivityRepository } from '@aramo/activity';
import { TaskRepository } from '@aramo/task';
import { EngagementRepository } from '@aramo/engagement';

// Boot the COMPILED AppModule (the exact graph the running API uses) so the
// repos resolve to the same dist wiring as @aramo/* (node_modules symlinks →
// dist/libs). Avoids jiti compiling all of apps/api source.
import { AppModule } from '../dist/apps/api/src/app.module.js';

import {
  assertNonProd,
  buildSeedPlan,
  seed,
  type SeedPorts,
} from './seed-e2e-data.lib.js';

interface Cli {
  readonly tenant: string;
  readonly recruiterUserId: string;
  readonly tag: string;
}

function parseCli(argv: readonly string[]): Cli {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t !== undefined && t.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(t.slice(2), next);
        i += 1;
      } else flags.set(t.slice(2), 'true');
    }
  }
  const tenant = flags.get('tenant');
  const recruiterUserId = flags.get('recruiter-user-id');
  if (tenant === undefined || tenant === '') {
    throw new Error('--tenant <TARGET_TENANT_ID> is required (PO-supplied).');
  }
  if (recruiterUserId === undefined || recruiterUserId === '') {
    throw new Error('--recruiter-user-id <USER_ID> is required (from the provisioning run).');
  }
  return { tenant, recruiterUserId, tag: flags.get('tag') ?? 'E2E ' };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  assertNonProd(process.env); // same prod-guard as the provisioning tool

  console.log(`[seed] env=${process.env['ARAMO_ENV']} · local DB OK · tenant=${cli.tenant} recruiter=${cli.recruiterUserId} tag='${cli.tag}'`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const company = app.get(CompanyRepository);
    const contact = app.get(ContactRepository);
    const talent = app.get(TalentRecordRepository);
    const requisition = app.get(RequisitionRepository);
    const assignment = app.get(RequisitionAssignmentRepository);
    const reqPrisma = app.get(RequisitionPrismaService);
    const pipeline = app.get(PipelineRepository);
    const activity = app.get(ActivityRepository);
    const task = app.get(TaskRepository);
    const engagement = app.get(EngagementRepository);

    const ports: SeedPorts = {
      // Idempotency: a READ-ONLY probe for a tagged requisition (a read, not a
      // write — within the "no raw INSERTs" rule). Bound to the live
      // RequisitionPrismaService.
      hasTaggedRequisition: async (tenantId, prefix) => {
        const row = await reqPrisma.requisition.findFirst({
          where: { tenant_id: tenantId, external_req_id: { startsWith: prefix } },
          select: { id: true },
        });
        return row !== null;
      },
      createCompany: async ({ tenantId, enteredById, name }) =>
        requireId(await company.create({ tenant_id: tenantId, entered_by_id: enteredById, input: { name }, scopes: [] })),
      createContact: async ({ tenantId, enteredById, companyId, first_name, last_name, email }) =>
        requireId(await contact.create({ tenant_id: tenantId, entered_by_id: enteredById, input: { company_id: companyId, first_name, last_name, email } })),
      createRequisition: async ({ tenantId, enteredById, recruiterUserId, spec, companyId, contactId }) =>
        requireId(await requisition.create({
          tenant_id: tenantId,
          entered_by_id: enteredById,
          scopes: [],
          requestId: randomUUID(),
          input: {
            title: spec.title,
            company_id: companyId,
            contact_id: contactId,
            type: spec.type,
            city: spec.city,
            state: spec.state,
            work_arrangement: spec.work_arrangement,
            openings: spec.openings,
            is_hot: spec.is_hot,
            external_req_id: spec.external_req_id,
            recruiter_id: recruiterUserId,
          },
        })),
      assignRequisition: async ({ tenantId, requisitionId, userId }) => {
        await assignment.assign({ tenant_id: tenantId, requisition_id: requisitionId, user_id: userId });
      },
      createTalent: async ({ tenantId, enteredById, ownerId, spec }) =>
        requireId(await talent.create({
          tenant_id: tenantId,
          entered_by_id: enteredById,
          input: {
            first_name: spec.first_name,
            last_name: spec.last_name,
            city: spec.city,
            state: spec.state,
            key_skills: spec.key_skills,
            current_pay: spec.current_pay,
            availability_status: spec.availability_status ?? undefined,
            engagement_type: spec.engagement_type ?? undefined,
            owner_id: ownerId,
          },
        })),
      createPipeline: async ({ tenantId, talentRecordId, requisitionId }) =>
        requireId(await pipeline.create({ tenant_id: tenantId, input: { talent_record_id: talentRecordId, requisition_id: requisitionId } })),
      // Bound to the live transition signature: { tenant_id, id, to_status,
      // changed_by_id, requestId }.
      transitionPipeline: async ({ tenantId, pipelineId, toStatus, changedById }) => {
        await pipeline.transition({
          tenant_id: tenantId,
          id: pipelineId,
          to_status: toStatus as never,
          changed_by_id: changedById,
          requestId: randomUUID(),
        });
      },
      createTask: async ({ tenantId, createdByUserId, assigneeId, title, ownerType, ownerId }) =>
        requireId(await task.create({ tenant_id: tenantId, created_by_user_id: createdByUserId, input: { title, owner_type: ownerType, owner_id: ownerId, assignee_id: assigneeId } })),
      createActivity: async ({ tenantId, createdById, subjectType, subjectId, notes }) =>
        requireId(await activity.create({ tenant_id: tenantId, created_by_id: createdById, input: { type: 'note', subject_type: subjectType, subject_id: subjectId, notes } })),
      // Bound to the live CreateEngagementInput: caller supplies id + event_id
      // (UUIDs); examination_id null (no Core dependency). Returns
      // CreateEngagementResult { engagement, event }.
      createEngagement: async ({ tenantId, talentId, requisitionId }) => {
        const res = await engagement.createEngagement({
          id: randomUUID(),
          event_id: randomUUID(),
          tenant_id: tenantId,
          talent_id: talentId,
          requisition_id: requisitionId,
          examination_id: null,
        });
        return requireId(res.engagement);
      },
    };

    const report = await seed(ports, { tenantId: cli.tenant, recruiterUserId: cli.recruiterUserId, tag: cli.tag }, buildSeedPlan(cli.tag));

    if (report.status === 'already_seeded') {
      console.log(`[seed] ALREADY SEEDED (tagged '${cli.tag}') — nothing to do (idempotent).`);
      return;
    }
    console.log('[seed] DONE — created via the real domain path:');
    console.log(`        tenant_id    = ${report.tenant_id}`);
    console.log(`        companies    = ${report.company_ids.join(', ')}`);
    console.log(`        contacts     = ${report.contact_ids.join(', ')}`);
    console.log(`        requisitions = ${report.requisition_ids.join(', ')} (each assigned to the recruiter)`);
    console.log(`        talent       = ${report.talent_ids.join(', ')}`);
    console.log(`        pipelines    = ${report.pipeline_ids.join(', ')}`);
    console.log(`        tasks        = ${report.task_ids.join(', ')}`);
    if (report.engagement_skipped !== undefined) {
      console.log(`        engagements  = (skipped: ${report.engagement_skipped})`);
    } else {
      console.log(`        engagements  = ${report.engagement_ids.join(', ')}`);
    }
  } finally {
    await app.close();
  }
}

function requireId(v: { id: string } | { readonly id: string }): { id: string } {
  if (v === null || typeof v.id !== 'string') {
    throw new Error('create did not return an id');
  }
  return { id: v.id };
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[seed] FAILED: ${message}`);
  process.exitCode = 1;
});
