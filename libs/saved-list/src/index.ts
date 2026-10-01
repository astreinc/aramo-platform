export { SavedListModule } from './lib/saved-list.module.js';
export { SavedListController } from './lib/saved-list.controller.js';
export { SavedListRepository } from './lib/saved-list.repository.js';
export { PrismaService as SavedListPrismaService } from './lib/prisma/prisma.service.js';

export {
  SAVED_LIST_ITEM_TYPE_VALUES,
  isSavedListItemType,
  type SavedListItemType,
  SAVED_LIST_VISIBILITY_VALUES,
  SAVED_LIST_DEFAULT_VISIBILITY,
  isSavedListVisibility,
  type SavedListVisibility,
  type SavedListView,
  type SavedListEntryView,
  type SavedListWithEntriesView,
  type CreateSavedListRequestDto,
  type AddSavedListEntryRequestDto,
} from './lib/dto/index.js';
