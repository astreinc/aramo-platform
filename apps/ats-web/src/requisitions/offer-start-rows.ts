import type { BoardCardView, BoardColumnKey, RequisitionTalentBoardView } from './requisition-talent-board-api';

// §11 — the Requisition "Offers & Starts" list is the authoritative board read filtered to the
// offer+ stages (client-selected → started). Each board card already carries the authoritative
// pipeline-episode id, so the Continue deep-link into /offer-start/:pipelineId needs NO FE
// pairing of offer↔pipeline (forbidden). Pure + presentation-free; the board is authoritative
// for membership and stage.
export const OFFER_START_COLUMNS: ReadonlySet<BoardColumnKey> = new Set<BoardColumnKey>([
  'selected',
  'offer',
  'accepted',
  'prestart',
  'ready',
  'started',
]);

export function selectOfferStartCards(board: RequisitionTalentBoardView | null): readonly BoardCardView[] {
  if (board === null) return [];
  return board.columns.flatMap((c) => c.cards).filter((card) => OFFER_START_COLUMNS.has(card.column));
}
