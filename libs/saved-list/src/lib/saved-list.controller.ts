import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { AddSavedListEntryRequestDto } from './dto/add-saved-list-entry-request.dto.js';
import type { CreateSavedListRequestDto } from './dto/create-saved-list-request.dto.js';
import type {
  SavedListEntryView,
  SavedListView,
  SavedListWithEntriesView,
} from './dto/saved-list.view.js';
import { SavedListRepository } from './saved-list.repository.js';

// SavedListController — PR-A6 Gate 5+6 (combined) — ATS finisher.
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes(...)                 // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// === Scope keys (NOT seeded — gap-and-note per A6 directive §9) ===
//
// `saved-list:read`, `saved-list:create`, `saved-list:edit`,
// `saved-list:delete` are referenced but NOT in the SEED_SCOPE_KEYS
// catalog at PR-A6. A future HK-SAVED-LIST-SCOPES bundle will seed
// them (mirrors HK-IDENT-SCOPES — A3/A4/A5a's gap closure). At PR-A6
// any caller's JWT must already carry these scopes for the routes to
// pass RolesGuard; the bare scopes-not-in-catalog state is a
// gap-and-note, not a breaking refusal.
//
// Recruiter divergence (Ruling 1):
//   - `:create` / `:edit` / `:read` — recruiter+.
//   - `:delete` — tenant_admin only (destructive: deleting a saved
//     list deletes all its entries via CASCADE).
//   - Entry add/remove key on `:edit` (recruiter+) — entry-removal is
//     a junction/link delete (NOT entity destruction), parallel to the
//     `attachment:delete` recruiter+ Ruling 1 carve-out.
@Controller('v1/saved-lists')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class SavedListController {
  constructor(private readonly savedListRepository: SavedListRepository) {}

  // ---------------------------------------------------------------------------
  // SavedList routes
  // ---------------------------------------------------------------------------

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('saved-list:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
  ): Promise<{ items: SavedListView[] }> {
    const items = await this.savedListRepository.listLists({
      tenant_id: authContext.tenant_id,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('saved-list:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<SavedListWithEntriesView> {
    const view = await this.savedListRepository.getListWithEntries({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'SavedList not found in tenant',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('saved-list:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateSavedListRequestDto,
  ): Promise<SavedListView> {
    return this.savedListRepository.createList({
      tenant_id: authContext.tenant_id,
      owner_id: authContext.sub,
      input: body,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('saved-list:delete')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.savedListRepository.deleteList({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }

  // ---------------------------------------------------------------------------
  // SavedListEntry routes (nested under a saved list)
  // ---------------------------------------------------------------------------

  @Post(':list_id/entries')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('saved-list:edit')
  @RequireSiteMatch()
  async addEntry(
    @AuthContext() authContext: AuthContextType,
    @Param('list_id') listId: string,
    @Body() body: AddSavedListEntryRequestDto,
    @RequestId() requestId: string,
  ): Promise<SavedListEntryView> {
    return this.savedListRepository.addEntry({
      tenant_id: authContext.tenant_id,
      saved_list_id: listId,
      input: body,
      requestId,
    });
  }

  @Delete(':list_id/entries/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('saved-list:edit')
  @RequireSiteMatch()
  async removeEntry(
    @AuthContext() authContext: AuthContextType,
    @Param('list_id') listId: string,
    @Param('id') entryId: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.savedListRepository.removeEntry({
      tenant_id: authContext.tenant_id,
      saved_list_id: listId,
      entry_id: entryId,
      requestId,
    });
  }
}
