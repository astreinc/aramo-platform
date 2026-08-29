export { ClientSelectionModule } from './lib/client-selection.module.js';
export { ClientSelectionController } from './lib/client-selection.controller.js';
export { ClientSelectionProcessRepository } from './lib/client-selection.repository.js';
export { PrismaService as ClientSelectionPrismaService } from './lib/prisma/prisma.service.js';
// Lane 2 / L2-F (F1) — the 7th outbox drain namespace, consumed by libs/outbox-publisher.
export { ClientSelectionOutboxRepository } from './lib/client-selection-outbox.repository.js';
export type { UnpublishedOutboxEvent as ClientSelectionUnpublishedOutboxEvent } from './lib/client-selection-outbox.repository.js';
export { ClientSelectionOutboxModule } from './lib/client-selection-outbox.module.js';

export {
  CLIENT_SELECTION_STATE_VALUES,
  CLIENT_SELECTION_INITIAL_STATE,
  CLIENT_SELECTION_TERMINAL_STATES,
  isClientSelectionState,
  isTerminalClientSelectionState,
  canTransitionClientSelection,
  legalNextClientSelectionStates,
  type ClientSelectionState,
} from './lib/client-selection-state.js';

export type { ClientSelectionProcessView } from './lib/dto/client-selection-process.view.js';
export type {
  TransitionClientSelectionRequestDto,
  CreateClientSelectionRequestDto,
} from './lib/dto/client-selection-request.dto.js';
