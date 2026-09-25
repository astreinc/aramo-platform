import { Button } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';

import {
  getRequisitionTalentBoard,
  BOARD_COLUMN_LABELS,
  BOARD_OWNER_LABELS,
  closedReasonLabel,
  blockerLabel,
  type BoardCardView,
  type BoardColumnKey,
  type BoardColumnView,
  type RequisitionTalentBoardView,
} from './requisition-talent-board-api';
import { governedDropTargets, resolveGovernedMove } from './board-governed-move';

// Requisition Talent Board (TB-2) — the read-only Board experience for Requisition Detail →
// Talent. A projection surface only: it renders the backend-authoritative column placement,
// owner-attributed state, Closed disposition, résumé linkage and Qualified band. It owns NO
// lifecycle truth and issues NO write (TB-3 adds the governed action menu; TB-5 governed
// drag). Clicking a card opens the SAME TalentDetailPanel drawer the List uses — the Board
// reuses the requisition's already-loaded pipelines via `onSelectCard(pipeline_id)` (no
// second per-card fetch). STATE ENUMS ONLY — no compensation/bill field is presented.

// The canonical left-to-right column order (mirrors the backend BOARD_COLUMN_ORDER).
const COLUMN_ORDER: readonly BoardColumnKey[] = [
  'pipeline',
  'contacted',
  'qualified',
  'submitted',
  'interview',
  'selected',
  'offer',
  'accepted',
  'prestart',
  'ready',
  'started',
];

export interface RequisitionTalentBoardProps {
  readonly requisitionId: string;
  /** Talent display names keyed by talent_record_id (from the requisition's List load). */
  readonly talentNames?: Readonly<Record<string, string | undefined>>;
  /** Open the shared TalentDetailPanel drawer for a card's pipeline episode. */
  readonly onSelectCard: (pipelineId: string) => void;
  /** The actor's scopes — the Board hides a next action the actor cannot perform (TB-3).
   *  UI hiding is never the boundary: the server re-authorizes every governed command. */
  readonly scopes?: readonly string[];
}

function talentLabel(names: RequisitionTalentBoardProps['talentNames'], id: string): string {
  const n = names?.[id];
  if (n !== undefined && n.trim().length > 0) return n;
  return `Talent ${id.slice(0, 8)}`;
}

function BoardCard({
  card,
  name,
  scopes,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCardView;
  name: string;
  scopes: readonly string[];
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}): JSX.Element {
  // Scope-gate the projected next actions (TB-3): only actions the actor can perform are
  // offered. The server re-authorizes on execution — this is presentation, not the boundary.
  const performable = card.next_actions.filter((a) => scopes.includes(a.required_scope));
  // TB-6 — a downstream (handoff) card is TRACKED read-only: not governed-draggable; its
  // commands live in the owning surface. The Board only projects its state + owner.
  return (
    <div
      className={`rc-tboard__card${card.handoff ? ' rc-tboard__card--tracked' : ''}`}
      draggable={!card.handoff}
      onDragStart={card.handoff ? undefined : (e) => { e.dataTransfer?.setData?.('text/plain', card.pipeline_id); onDragStart(); }}
      onDragEnd={card.handoff ? undefined : onDragEnd}
    >
      <Button unstyled type="button" className="rc-tboard__card-main" onClick={onSelect} aria-label={`Open ${name}`}>
        <span className="rc-tboard__card-name">{name}</span>
        <span className="rc-tboard__card-meta">
          {card.handoff && (
            <span className="rc-tboard__tracked" title={`Tracked from ${BOARD_OWNER_LABELS[card.owner]} — the Board does not own this stage`}>
              Tracked · {BOARD_OWNER_LABELS[card.owner]}
            </span>
          )}
          {card.readiness?.band != null && (
            <span
              className={`rc-tboard__band rc-tboard__band--${card.readiness.band}`}
              data-band={card.readiness.band}
            >
              {card.readiness.band === 'ready_to_submit' ? 'Ready to submit' : 'Needs action'}
            </span>
          )}
          {card.resume.locked && (
            <span className="rc-tboard__resume-lock" title="Submitted résumé (frozen)">
              Résumé locked
            </span>
          )}
          {card.rtr_state === 'NOT_EXECUTED' && (
            <span className="rc-tboard__rtr" title="Right to represent not executed">
              RTR needed
            </span>
          )}
          {card.days_in_stage != null && (
            <span className="rc-tboard__days">{card.days_in_stage}d in stage</span>
          )}
        </span>
        {card.readiness?.band === 'needs_action' && card.readiness.blockers.length > 0 && (
          <span className="rc-tboard__blockers">
            {card.readiness.blockers.map((b) => blockerLabel(b)).join(' · ')}
          </span>
        )}
      </Button>
      {performable.length > 0 && (
        <div className="rc-tboard__actions" aria-label={`Actions for ${name}`}>
          {performable.map((a) => (
            // The governed command executes in the owning drawer surface (TB-3 routes there;
            // TB-5 will drive the same projected command directly). The Board never
            // re-implements an owner command.
            <Button key={a.key} unstyled type="button" className="rc-tboard__action" onClick={onSelect} title={a.command_route}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function BoardColumn({
  column,
  talentNames,
  scopes,
  onSelectCard,
  isDropTarget,
  onDragStartCard,
  onDragEndCard,
  onDropCard,
}: {
  column: BoardColumnView;
  talentNames: RequisitionTalentBoardProps['talentNames'];
  scopes: readonly string[];
  onSelectCard: (pipelineId: string) => void;
  isDropTarget: boolean;
  onDragStartCard: (card: BoardCardView) => void;
  onDragEndCard: () => void;
  onDropCard: (targetColumn: BoardColumnKey) => void;
}): JSX.Element {
  // The Qualified column splits into its two readiness bands (§6); every other column is flat.
  const isQualified = column.key === 'qualified';
  const ready = isQualified ? column.cards.filter((c) => c.readiness?.band === 'ready_to_submit') : [];
  const needs = isQualified ? column.cards.filter((c) => c.readiness?.band !== 'ready_to_submit') : [];
  const renderCard = (c: BoardCardView): JSX.Element => (
    <BoardCard
      key={c.pipeline_id}
      card={c}
      name={talentLabel(talentNames, c.talent_record_id)}
      scopes={scopes}
      onSelect={() => onSelectCard(c.pipeline_id)}
      onDragStart={() => onDragStartCard(c)}
      onDragEnd={onDragEndCard}
    />
  );

  return (
    <section
      className={`rc-tboard__col${isDropTarget ? ' rc-tboard__col--drop' : ''}`}
      aria-label={BOARD_COLUMN_LABELS[column.key]}
      data-drop-target={isDropTarget || undefined}
      onDragOver={(e) => { if (isDropTarget) e.preventDefault(); }}
      onDrop={(e) => { if (isDropTarget) { e.preventDefault(); onDropCard(column.key); } }}
    >
      <header className="rc-tboard__col-head">
        <span className="rc-tboard__col-title">{BOARD_COLUMN_LABELS[column.key]}</span>
        <span className="rc-tboard__col-count">{column.count}</span>
      </header>
      <div className="rc-tboard__col-body">
        {column.count === 0 ? (
          <p className="rc-tboard__empty">—</p>
        ) : isQualified ? (
          <>
            {ready.length > 0 && (
              <div className="rc-tboard__band-group">
                <p className="rc-tboard__band-label">Ready to submit</p>
                {ready.map(renderCard)}
              </div>
            )}
            {needs.length > 0 && (
              <div className="rc-tboard__band-group">
                <p className="rc-tboard__band-label">Needs action</p>
                {needs.map(renderCard)}
              </div>
            )}
          </>
        ) : (
          column.cards.map(renderCard)
        )}
      </div>
    </section>
  );
}

export function RequisitionTalentBoard({ requisitionId, talentNames, onSelectCard, scopes = [] }: RequisitionTalentBoardProps): JSX.Element {
  const [board, setBoard] = useState<RequisitionTalentBoardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  // TB-5 — the card currently being governed-dragged (null when idle).
  const [dragging, setDragging] = useState<BoardCardView | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    getRequisitionTalentBoard(requisitionId)
      .then((b) => { if (live) setBoard(b); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [requisitionId]);

  // Render every column in canonical order, even when the backend omitted an empty one.
  const columns = useMemo(() => {
    const byKey = new Map((board?.columns ?? []).map((c) => [c.key, c]));
    return COLUMN_ORDER.map(
      (key): BoardColumnView => byKey.get(key) ?? { key, owner: 'pipeline', count: 0, cards: [] },
    );
  }, [board]);

  // TB-5 — the columns the dragged card MAY be governed-dropped into (§3.2 ceiling; scope-gated).
  const validTargets = dragging !== null ? governedDropTargets(dragging, COLUMN_ORDER, scopes) : null;

  // A governed drop: accepted ONLY when it maps to the card's projected governed action; the
  // mutation flows through the existing governed command surface (never a Board-side write).
  const onDropCard = (targetColumn: BoardColumnKey): void => {
    if (dragging === null) return;
    const move = resolveGovernedMove({ card: dragging, targetColumn, columnOrder: COLUMN_ORDER, scopes });
    const card = dragging;
    setDragging(null);
    if (move.ok) onSelectCard(card.pipeline_id); // route to the governed command surface (TB-3 path)
    // Rejected drops snap back (no-op) — the governance is the resolver, not the drop target.
  };

  if (loading) return <p className="rc-tboard__status" role="status">Loading board…</p>;
  if (error.length > 0) return <p className="rc-tboard__status rc-tboard__status--error" role="alert">{error}</p>;
  if (board === null) return <p className="rc-tboard__status">No board.</p>;

  return (
    <div className="rc-tboard" aria-label="Talent board">
      <div className="rc-tboard__cols">
        {columns.map((col) => (
          <BoardColumn
            key={col.key}
            column={col}
            talentNames={talentNames}
            scopes={scopes}
            onSelectCard={onSelectCard}
            isDropTarget={validTargets?.has(col.key) ?? false}
            onDragStartCard={setDragging}
            onDragEndCard={() => setDragging(null)}
            onDropCard={onDropCard}
          />
        ))}
      </div>
      {board.closed.total > 0 && (
        <details className="rc-tboard__closed">
          <summary className="rc-tboard__closed-summary">
            Closed <span className="rc-tboard__col-count">{board.closed.total}</span>
          </summary>
          <ul className="rc-tboard__closed-list">
            {board.closed.by_reason.map((r) => (
              <li key={r.reason} className="rc-tboard__closed-row">
                <span>{closedReasonLabel(r.reason)}</span>
                <span className="rc-tboard__col-count">{r.count}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
