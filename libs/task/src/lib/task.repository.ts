import { Injectable } from '@nestjs/common';
import type { VisibilityContextShape } from '@aramo/common';

import type { CreateTaskRequestDto } from './dto/create-task-request.dto.js';
import type { TaskOwnerType } from './dto/task-owner-type.js';
import type { TaskStatus } from './dto/task-status.js';
import type { TaskView } from './dto/task.view.js';
import type { UpdateTaskRequestDto } from './dto/update-task-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// TaskRepository — write + read surface for Task.
//
// THE LOAD-BEARING PIECE: every read ANDs the linked-entity visibility (a task
// whose owner the actor cannot see is absent). The composition REUSES the
// libs/visibility resolvers (passed down from the controller as resolved sets)
// — it does NOT reinvent visibility. The 4 owner_types:
//   - talent_record → UNRESTRICTED (pool-open §5 boundary — a talent is a
//                     tenant-wide read).
//   - requisition   → owner_id ∈ visible_requisition_ids (A3-OR-D4b).
//   - company       → owner_id ∈ visible_client_ids (D4b).
//   - contact       → owner_id ∈ visible_contact_ids (the NEW resolver — a
//                     contact inherits its company's visibility).
// Mirrors libs/activity buildActivityVisibilityWhere (minus pipeline, plus
// contact) — the same query-layer OR per DDR D6 (no fetch-then-filter).

interface TaskRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  due_date: Date | null;
  status: TaskStatus;
  assignee_id: string | null;
  created_by_user_id: string;
  owner_type: string;
  owner_id: string;
  created_at: Date;
  updated_at: Date;
}

function projectView(row: TaskRow): TaskView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    title: row.title,
    description: row.description,
    due_date: row.due_date === null ? null : row.due_date.toISOString(),
    status: row.status,
    assignee_id: row.assignee_id,
    created_by_user_id: row.created_by_user_id,
    owner_type: row.owner_type as TaskOwnerType,
    owner_id: row.owner_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export interface TaskVisibilityInputs {
  visibility: VisibilityContextShape;
  visible_requisition_ids: ReadonlySet<string> | null;
  visible_contact_ids: ReadonlySet<string> | null;
}

@Injectable()
export class TaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Write ----

  async create(args: {
    tenant_id: string;
    created_by_user_id: string;
    input: CreateTaskRequestDto;
  }): Promise<TaskView> {
    const row = await this.prisma.task.create({
      data: {
        tenant_id: args.tenant_id,
        title: args.input.title,
        description: args.input.description ?? null,
        due_date:
          args.input.due_date === undefined
            ? null
            : new Date(args.input.due_date),
        assignee_id: args.input.assignee_id ?? null,
        created_by_user_id: args.created_by_user_id,
        owner_type: args.input.owner_type,
        owner_id: args.input.owner_id,
      },
    });
    return projectView(row as TaskRow);
  }

  // Plain tenant-scoped fetch (no visibility) — the controller composes
  // visibility separately for the gate; this exists for the mutate path's
  // existence check after the visible-gate has passed.
  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<TaskView | null> {
    const row = await this.prisma.task.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as TaskRow);
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateTaskRequestDto;
  }): Promise<TaskView> {
    const i = args.input;
    const data: Record<string, unknown> = {};
    if (i.title !== undefined) data['title'] = i.title;
    if (i.description !== undefined) data['description'] = i.description;
    if (i.due_date !== undefined) {
      data['due_date'] = i.due_date === null ? null : new Date(i.due_date);
    }
    if (i.status !== undefined) data['status'] = i.status;
    if (i.assignee_id !== undefined) data['assignee_id'] = i.assignee_id;
    const row = await this.prisma.task.update({
      where: { id: args.id },
      data,
    });
    return projectView(row as TaskRow);
  }

  async delete(args: { id: string }): Promise<void> {
    await this.prisma.task.delete({ where: { id: args.id } });
  }

  // ---- Read (visibility-scoped) ----

  async findByIdForActor(args: {
    tenant_id: string;
    id: string;
    vis: TaskVisibilityInputs;
  }): Promise<TaskView | null> {
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      id: args.id,
      ...buildTaskVisibilityWhere(args.vis),
    };
    const row = await this.prisma.task.findFirst({ where });
    return row === null ? null : projectView(row as TaskRow);
  }

  // my-tasks: tasks assigned to the actor (default status filter applied by
  // the caller), due-date-sorted, ANDed with visibility.
  async listForAssignee(args: {
    tenant_id: string;
    assignee_id: string;
    status?: TaskStatus;
    vis: TaskVisibilityInputs;
    limit?: number;
  }): Promise<TaskView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      assignee_id: args.assignee_id,
      ...(args.status === undefined ? {} : { status: args.status }),
      ...buildTaskVisibilityWhere(args.vis),
    };
    const rows = await this.prisma.task.findMany({
      where,
      orderBy: [{ due_date: 'asc' }, { created_at: 'asc' }],
      take: limit,
    });
    return (rows as TaskRow[]).map(projectView);
  }

  // by-entity: tasks on a given owner, ANDed with visibility (the owner's own
  // branch only matches if owner_id is in that owner_type's visible set).
  async listForOwner(args: {
    tenant_id: string;
    owner_type: TaskOwnerType;
    owner_id: string;
    status?: TaskStatus;
    vis: TaskVisibilityInputs;
    limit?: number;
  }): Promise<TaskView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      owner_type: args.owner_type,
      owner_id: args.owner_id,
      ...(args.status === undefined ? {} : { status: args.status }),
      ...buildTaskVisibilityWhere(args.vis),
    };
    const rows = await this.prisma.task.findMany({
      where,
      orderBy: [{ due_date: 'asc' }, { created_at: 'asc' }],
      take: limit,
    });
    return (rows as TaskRow[]).map(projectView);
  }

  // Segment 4c — preset resolution ("Needs follow-up"). Returns the DISTINCT
  // talent_record ids (owner_type='talent_record') that have an OPEN task
  // ASSIGNED to `assignee_id` (the assignee — NOT the creator) whose due_date
  // is today or earlier (overdue OR due-today, where `as_of` is end-of-today).
  // Resolve-then-filter: hands back the talent ids only; the talent-record lib
  // narrows by them — no reach from talent-record into the task schema. Bounded
  // by `limit` (distinct owner_id, take limit+1) for the 4b guard. The
  // (tenant_id, assignee_id, due_date) index serves the selective predicate;
  // the binary status is a residual filter.
  async findTalentIdsWithDueOrOverdueTasksForAssignee(args: {
    tenant_id: string;
    assignee_id: string;
    as_of: Date;
    limit: number;
  }): Promise<string[]> {
    const rows = await this.prisma.task.findMany({
      where: {
        tenant_id: args.tenant_id,
        assignee_id: args.assignee_id,
        owner_type: 'talent_record',
        status: 'open',
        due_date: { not: null, lte: args.as_of },
      },
      select: { owner_id: true },
      distinct: ['owner_id'],
      take: args.limit + 1,
      orderBy: { due_date: 'asc' },
    });
    return rows.map((r) => r.owner_id);
  }
}

// Build the Task polymorphic visibility OR (query-layer per DDR D6). Returns
// {} when the actor has see-all for BOTH company + requisition (contact
// derives from company → also all; talent_record is always pool-open). Empty
// IN-sets collapse a branch to "no match" (Prisma handles `in: []`).
export function buildTaskVisibilityWhere(
  inputs: TaskVisibilityInputs,
): Record<string, unknown> {
  const seeAllCompany = inputs.visibility.see_all_company;
  const seeAllReq = inputs.visibility.see_all_requisition;
  if (seeAllCompany && seeAllReq) return {};

  const visibleClients = inputs.visibility.visible_client_ids;
  const visibleReqs = inputs.visible_requisition_ids;
  const visibleContacts = inputs.visible_contact_ids;

  const branches: Array<Record<string, unknown>> = [];

  // talent_record — UNRESTRICTED (pool-open §5 boundary).
  branches.push({ owner_type: 'talent_record' });

  // requisition
  if (visibleReqs === null) {
    branches.push({ owner_type: 'requisition' });
  } else {
    branches.push({
      owner_type: 'requisition',
      owner_id: { in: Array.from(visibleReqs) },
    });
  }

  // company
  if (seeAllCompany || visibleClients === null) {
    branches.push({ owner_type: 'company' });
  } else {
    branches.push({
      owner_type: 'company',
      owner_id: { in: Array.from(visibleClients) },
    });
  }

  // contact — inherits company visibility via the resolveVisibleContactIds set.
  if (visibleContacts === null) {
    branches.push({ owner_type: 'contact' });
  } else {
    branches.push({
      owner_type: 'contact',
      owner_id: { in: Array.from(visibleContacts) },
    });
  }

  return { OR: branches };
}

// Create-time assert helper (the engagement assertRequisitionVisible
// precedent). True iff the owner entity is visible to the actor — the
// controller throws 404 when false.
export function isOwnerVisible(
  owner_type: TaskOwnerType,
  owner_id: string,
  inputs: TaskVisibilityInputs,
): boolean {
  switch (owner_type) {
    case 'talent_record':
      return true; // pool-open
    case 'requisition':
      return (
        inputs.visible_requisition_ids === null ||
        inputs.visible_requisition_ids.has(owner_id)
      );
    case 'company':
      return (
        inputs.visibility.see_all_company ||
        inputs.visibility.visible_client_ids === null ||
        inputs.visibility.visible_client_ids.has(owner_id)
      );
    case 'contact':
      return (
        inputs.visible_contact_ids === null ||
        inputs.visible_contact_ids.has(owner_id)
      );
    default:
      return false;
  }
}
