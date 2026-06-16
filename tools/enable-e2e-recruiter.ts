// DB-ONLY recruiter-role enablement for the e2e recruiter (recruiter@aramo.dev).
//
// NO Cognito, NO AWS, NO provisioning, NO push. Lays the identity substrate so
// the recruiter is assignable/visible. NOTE (recon B): the login path links by
// Cognito `sub` (ExternalIdentity), NOT verified email — so this seed alone does
// NOT enable hosted-UI login; an ExternalIdentity(provider='cognito',
// provider_subject=<real sub>) link is still required once the Cognito user
// exists. That step is intentionally out of scope here.
//
// What it does (idempotent):
//   1. Seed identity.User recruiter@aramo.dev + a SINGLE membership in the
//      locked tenant + the `recruiter` role (raw identity Prisma — there is no
//      Cognito-free service method for this).
//   2. ADDITIVELY assign the 3 tagged reqs (E2E REQ-9001/9002/9003) to the
//      recruiter via the REAL RequisitionAssignment.assign (admin's stay).
//   3. Seed 2 recruiter-owned tagged tasks via the REAL Task.create (admin's
//      tasks are left intact — no reassign).
//
// RUN (local stack only; env loaded; dist built):
//   set -a && source .env && set +a
//   node --import jiti/register tools/enable-e2e-recruiter.ts

import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { PrismaService } from '@aramo/identity';
import { RequisitionAssignmentRepository } from '@aramo/requisition';
import { TaskRepository } from '@aramo/task';

import { AppModule } from '../dist/apps/api/src/app.module.js';

import { assertNonProd } from './seed-e2e-data.lib.js';

const TENANT = '01900000-0000-7000-8000-000000000001';
const RECRUITER_EMAIL = 'recruiter@aramo.dev';
const RECRUITER_DISPLAY = 'Aramo Dev Recruiter';
const RECRUITER_ROLE_ID = '01900000-0000-7000-8000-000000000011'; // role key 'recruiter'
const ADMIN_ID = '01900000-0000-7000-8000-000000000002'; // assigned_by / created_by

const REQ_IDS = [
  '755021d6-8661-441b-9bd5-f18a8321a615', // E2E REQ-9001
  '899800af-a541-4cd2-b239-7f8dbf447cbf', // E2E REQ-9002
  '98e68661-b4a1-40a5-9c49-6a7d373cc4ac', // E2E REQ-9003
] as const;

const TASK_TAG = 'E2E (recruiter) ';

async function main(): Promise<void> {
  assertNonProd(process.env);
  console.log(
    `[enable] env=${process.env['ARAMO_ENV']} · local DB OK · tenant=${TENANT} email=${RECRUITER_EMAIL}`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const assignment = app.get(RequisitionAssignmentRepository);
    const task = app.get(TaskRepository);

    // --- Step 1: identity.User + single membership + recruiter role ---
    const recruiterUserId = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { email: RECRUITER_EMAIL },
        select: { id: true },
      });
      const userId = existing?.id ?? randomUUID();
      if (existing === null) {
        await tx.user.create({
          data: {
            id: userId,
            email: RECRUITER_EMAIL,
            display_name: RECRUITER_DISPLAY,
            is_active: true,
          },
        });
        console.log(`[enable] created identity.User ${userId}`);
      } else {
        console.log(`[enable] identity.User already present ${userId}`);
      }

      // Single membership (unique on [user_id, tenant_id]).
      const membership = await tx.userTenantMembership.upsert({
        where: { user_id_tenant_id: { user_id: userId, tenant_id: TENANT } },
        update: {},
        create: {
          id: randomUUID(),
          user_id: userId,
          tenant_id: TENANT,
          site_id: null,
          is_active: true,
        },
        select: { id: true },
      });

      // Recruiter role on that membership (unique on [membership_id, role_id]).
      await tx.userTenantMembershipRole.upsert({
        where: {
          membership_id_role_id: {
            membership_id: membership.id,
            role_id: RECRUITER_ROLE_ID,
          },
        },
        update: {},
        create: {
          id: randomUUID(),
          membership_id: membership.id,
          role_id: RECRUITER_ROLE_ID,
        },
      });
      return userId;
    });

    // --- Step 2: ADDITIVE requisition assignments (real method) ---
    const assigned: string[] = [];
    for (const requisition_id of REQ_IDS) {
      await assignment.assign({
        tenant_id: TENANT,
        requisition_id,
        user_id: recruiterUserId,
        assigned_by_id: ADMIN_ID,
        requestId: randomUUID(),
      });
      assigned.push(requisition_id);
    }

    // --- Step 3: 2 recruiter-owned tasks (real method; admin's left intact) ---
    const TASKS = [
      {
        title: `${TASK_TAG}Send references to the client`,
        owner_id: REQ_IDS[0],
        // past due → surfaces as "Overdue" in "needs you today"
        due_date: '2026-06-10T09:00:00.000Z',
      },
      {
        title: `${TASK_TAG}Follow up after screen`,
        owner_id: REQ_IDS[1],
        due_date: '2026-06-20T09:00:00.000Z',
      },
    ] as const;

    const createdTaskIds: string[] = [];
    for (const t of TASKS) {
      const dup = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM task."Task" WHERE tenant_id = $1 AND title = $2 AND assignee_id = $3 LIMIT 1`,
        TENANT,
        t.title,
        recruiterUserId,
      );
      if (dup.length > 0) {
        console.log(`[enable] task already present (${t.title}) ${dup[0]!.id}`);
        createdTaskIds.push(dup[0]!.id);
        continue;
      }
      const created = await task.create({
        tenant_id: TENANT,
        created_by_user_id: ADMIN_ID,
        input: {
          title: t.title,
          owner_type: 'requisition',
          owner_id: t.owner_id,
          assignee_id: recruiterUserId,
          due_date: t.due_date,
        },
      });
      createdTaskIds.push(created.id);
    }

    // --- Step 4: report ---
    const scopes = await prisma.$queryRawUnsafe<{ key: string }[]>(
      `SELECT s.key FROM identity."UserTenantMembership" m
         JOIN identity."UserTenantMembershipRole" mr ON mr.membership_id = m.id
         JOIN identity."RoleScope" rs ON rs.role_id = mr.role_id
         JOIN identity."Scope" s ON s.id = rs.scope_id
        WHERE m.user_id = $1 AND m.tenant_id = $2
        ORDER BY s.key`,
      recruiterUserId,
      TENANT,
    );

    console.log('\n[enable] DONE — DB substrate in place:');
    console.log(`        recruiter user_id = ${recruiterUserId}`);
    console.log(`        tenant_id         = ${TENANT}`);
    console.log(`        role              = recruiter (${RECRUITER_ROLE_ID})`);
    console.log(`        scopes (${scopes.length})       = ${scopes.map((s) => s.key).join(', ')}`);
    console.log(`        reqs assigned     = ${assigned.join(', ')} (additive)`);
    console.log(`        recruiter tasks   = ${createdTaskIds.join(', ')}`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[enable] FAILED: ${message}`);
  process.exitCode = 1;
});
