import { describe, expect, it } from 'vitest';

import type { BoardCardView, BoardColumnKey, RequisitionTalentBoardView } from './requisition-talent-board-api';
import { selectOfferStartCards } from './offer-start-rows';

function card(column: BoardColumnKey, pipeline_id: string, talent_record_id = `t-${pipeline_id}`): BoardCardView {
  return {
    talent_record_id,
    pipeline_id,
    column,
    owner: 'pipeline',
    source_object_id: pipeline_id,
    owner_state: column,
    resume: { resume_edition_id: null, source: 'none', locked: false },
    rtr_state: null,
    readiness: null,
    days_in_stage: null,
    stage_entered_at: null,
    assigned_recruiter_user_id: null,
    next_actions: [],
    handoff: false,
  };
}

function board(cards: BoardCardView[]): RequisitionTalentBoardView {
  // One column object is enough — selectOfferStartCards flattens all columns' cards.
  return { columns: [{ key: 'pipeline', owner: 'pipeline', count: cards.length, cards }] } as unknown as RequisitionTalentBoardView;
}

describe('selectOfferStartCards — the Requisition Offers & Starts list (§11)', () => {
  it('keeps only offer+ stages (selected → started), carrying the authoritative pipeline_id', () => {
    const rows = selectOfferStartCards(
      board([
        card('qualified', 'p-early'),
        card('submitted', 'p-sub'),
        card('interview', 'p-iv'),
        card('selected', 'p1'),
        card('offer', 'p2'),
        card('accepted', 'p3'),
        card('prestart', 'p4'),
        card('ready', 'p5'),
        card('started', 'p6'),
      ]),
    );
    expect(rows.map((r) => r.pipeline_id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('excludes pre-offer recruiting stages (no_contact → interview)', () => {
    const rows = selectOfferStartCards(board([card('pipeline', 'a'), card('contacted', 'b'), card('qualified', 'c'), card('submitted', 'd'), card('interview', 'e')]));
    expect(rows).toHaveLength(0);
  });

  it('null board → empty (loading)', () => {
    expect(selectOfferStartCards(null)).toHaveLength(0);
  });
});
