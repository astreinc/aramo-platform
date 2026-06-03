import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CompanyRepository } from '@aramo/company';
import { ContactRepository } from '@aramo/contact';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentRecordRepository } from '@aramo/talent-record';

import type { AddSavedListEntryRequestDto } from './dto/add-saved-list-entry-request.dto.js';
import type { CreateSavedListRequestDto } from './dto/create-saved-list-request.dto.js';
import type { SavedListItemType } from './dto/saved-list-item-type.js';
import type {
  SavedListEntryView,
  SavedListView,
  SavedListWithEntriesView,
} from './dto/saved-list.view.js';
import { PrismaService } from './prisma/prisma.service.js';

// SavedListRepository — write + read surface for SavedList + SavedListEntry.
// Reference CRUD (Ruling 7: no metering, no event log, no state machine).
//
// === Typed polymorphism — the A4 attachment shape ===
//
// Each SavedListEntry holds (item_type, item_id) — a typed pointer to a
// row in another PG namespace. Cross-schema FK is forbidden
// (Architecture §7.3), so referential integrity is the service's
// responsibility at add-entry time:
//
//   1. Read item_type (the discriminator).
//   2. Dispatch to the matching repository's tenant-scoped findById.
//   3. Reject with NOT_FOUND when the row is absent OR is in a
//      different tenant (the matching repository scopes findById by
//      tenant, so cross-tenant looks like absent).
//
// Unlike PR-A4 (which stubbed 3 of 4 owner types as VALIDATION_ERROR
// because only `talent` was live at the time), PR-A6 wires ALL FOUR
// ATS entities — they are all live at the A6 substrate.
//
// === Homogeneity invariant ===
//
// A SavedList's `item_type` is fixed at creation; every entry's
// `item_type` must equal the parent list's. Per-add mismatch →
// SAVED_LIST_ITEM_TYPE_MISMATCH (422). This is the typed-polymorphism
// integrity check at the LIST side (vs. the per-entry owner check
// that integrity-checks the typed entity).

interface SavedListRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  owner_id: string;
  name: string;
  item_type: SavedListItemType;
  created_at: Date;
  updated_at: Date;
}

interface SavedListEntryRow {
  id: string;
  tenant_id: string;
  saved_list_id: string;
  item_type: SavedListItemType;
  item_id: string;
  created_at: Date;
}

function projectListView(row: SavedListRow): SavedListView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    owner_id: row.owner_id,
    name: row.name,
    item_type: row.item_type,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function projectEntryView(row: SavedListEntryRow): SavedListEntryView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    saved_list_id: row.saved_list_id,
    item_type: row.item_type,
    item_id: row.item_id,
    created_at: row.created_at.toISOString(),
  };
}

@Injectable()
export class SavedListRepository {
  private readonly logger = new Logger(SavedListRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly talentRecordRepository: TalentRecordRepository,
    private readonly companyRepository: CompanyRepository,
    private readonly contactRepository: ContactRepository,
    private readonly requisitionRepository: RequisitionRepository,
  ) {}

  /**
   * Validate that `item_id` resolves to an in-tenant row of `item_type`.
   * All 4 ATS entities are wired (vs. PR-A4 attachment which stubbed 3
   * of 4 — at A6 the ATS substrate is complete). Throws NOT_FOUND on
   * absence / cross-tenant.
   */
  private async validateOwner(args: {
    tenant_id: string;
    item_type: SavedListItemType;
    item_id: string;
    requestId: string;
  }): Promise<void> {
    let exists = false;
    switch (args.item_type) {
      case 'talent_record': {
        const row = await this.talentRecordRepository.findById({
          tenant_id: args.tenant_id,
          id: args.item_id,
        });
        exists = row !== null;
        break;
      }
      case 'company': {
        const row = await this.companyRepository.findById({
          tenant_id: args.tenant_id,
          id: args.item_id,
        });
        exists = row !== null;
        break;
      }
      case 'contact': {
        const row = await this.contactRepository.findById({
          tenant_id: args.tenant_id,
          id: args.item_id,
        });
        exists = row !== null;
        break;
      }
      case 'requisition': {
        const row = await this.requisitionRepository.findByIdAdmin({
          tenant_id: args.tenant_id,
          id: args.item_id,
        });
        exists = row !== null;
        break;
      }
    }
    if (!exists) {
      throw new AramoError(
        'NOT_FOUND',
        `SavedListEntry item (${args.item_type}) not found in tenant`,
        404,
        {
          requestId: args.requestId,
          details: { item_type: args.item_type, item_id: args.item_id },
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // SavedList write + read
  // -------------------------------------------------------------------------

  async createList(args: {
    tenant_id: string;
    owner_id: string;
    input: CreateSavedListRequestDto;
  }): Promise<SavedListView> {
    const row = await this.prisma.savedList.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.input.site_id ?? null,
        owner_id: args.owner_id,
        name: args.input.name,
        item_type: args.input.item_type,
      },
    });
    return projectListView(row as SavedListRow);
  }

  async findListById(args: {
    tenant_id: string;
    id: string;
  }): Promise<SavedListView | null> {
    const row = await this.prisma.savedList.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectListView(row as SavedListRow);
  }

  async getListWithEntries(args: {
    tenant_id: string;
    id: string;
  }): Promise<SavedListWithEntriesView | null> {
    const row = await this.prisma.savedList.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      include: { entries: { orderBy: { created_at: 'asc' } } },
    });
    if (row === null) return null;
    const list = projectListView(row as SavedListRow);
    const entries = (row.entries as SavedListEntryRow[]).map(projectEntryView);
    return { ...list, entries };
  }

  // PR-A7 — tenant-scoped count for the reporting aggregator.
  async count(args: {
    tenant_id: string;
    site_id?: string;
  }): Promise<number> {
    return this.prisma.savedList.count({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
    });
  }

  async listLists(args: {
    tenant_id: string;
    site_id?: string;
    item_type?: SavedListItemType;
    limit?: number;
  }): Promise<SavedListView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.savedList.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        ...(args.item_type === undefined ? {} : { item_type: args.item_type }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as SavedListRow[]).map(projectListView);
  }

  async deleteList(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.findListById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'SavedList not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    // Cascade delete handles SavedListEntry rows (intra-schema FK).
    await this.prisma.savedList.delete({ where: { id: args.id } });
  }

  // -------------------------------------------------------------------------
  // SavedListEntry write + read
  // -------------------------------------------------------------------------

  async addEntry(args: {
    tenant_id: string;
    saved_list_id: string;
    input: AddSavedListEntryRequestDto;
    requestId: string;
  }): Promise<SavedListEntryView> {
    // 1. Parent list must exist in tenant.
    const parent = await this.findListById({
      tenant_id: args.tenant_id,
      id: args.saved_list_id,
    });
    if (parent === null) {
      throw new AramoError(
        'NOT_FOUND',
        'SavedList not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { saved_list_id: args.saved_list_id },
        },
      );
    }

    // 2. Homogeneity invariant — entry.item_type == parent.item_type.
    if (args.input.item_type !== parent.item_type) {
      throw new AramoError(
        'SAVED_LIST_ITEM_TYPE_MISMATCH',
        `SavedListEntry item_type '${args.input.item_type}' does not match parent list item_type '${parent.item_type}'`,
        422,
        {
          requestId: args.requestId,
          details: {
            saved_list_id: args.saved_list_id,
            list_item_type: parent.item_type,
            entry_item_type: args.input.item_type,
          },
        },
      );
    }

    // 3. Typed-polymorphism integrity — referenced entity exists in tenant.
    await this.validateOwner({
      tenant_id: args.tenant_id,
      item_type: args.input.item_type,
      item_id: args.input.item_id,
      requestId: args.requestId,
    });

    // 4. Insert (the @@unique([saved_list_id, item_id]) prevents dupes).
    const row = await this.prisma.savedListEntry.create({
      data: {
        tenant_id: args.tenant_id,
        saved_list_id: args.saved_list_id,
        item_type: args.input.item_type,
        item_id: args.input.item_id,
      },
    });
    return projectEntryView(row as SavedListEntryRow);
  }

  async removeEntry(args: {
    tenant_id: string;
    saved_list_id: string;
    entry_id: string;
    requestId: string;
  }): Promise<void> {
    const row = await this.prisma.savedListEntry.findFirst({
      where: {
        tenant_id: args.tenant_id,
        saved_list_id: args.saved_list_id,
        id: args.entry_id,
      },
    });
    if (row === null) {
      throw new AramoError(
        'NOT_FOUND',
        'SavedListEntry not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: {
            saved_list_id: args.saved_list_id,
            entry_id: args.entry_id,
          },
        },
      );
    }
    await this.prisma.savedListEntry.delete({ where: { id: args.entry_id } });
  }
}
