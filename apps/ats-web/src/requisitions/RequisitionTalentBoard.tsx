import { Button } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';

import {
  getRequisitionTalentBoard,
  BOARD_COLUMN_LABELS,
  closedReasonLabel,
  blockerLabel,
  type BoardCardView,
  type BoardColumnKey,
  type BoardColumnView,
  type RequisitionTalentBoardView,
} from './requisition-talent-board-api';

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
}: {
  card: BoardCardView;
  name: string;
  scopes: readonly string[];
  onSelect: () => void;
}): JSX.Element {
  // Scope-gate the projected next actions (TB-3): only actions the actor can perform are
  // offered. The server re-authorizes on execution — this is presentation, not the boundary.
  const performable = card.next_actions.filter((a) => scopes.includes(a.required_scope));
  return (
    <div className="rc-board__card">
      <Button unstyled type="button" className="rc-board__card-main" onClick={onSelect} aria-label={`Open ${name}`}>
        <span className="rc-board__card-name">{name}</span>
        <span className="rc-board__card-meta">
          {card.readiness?.band != null && (
            <span
              className={`rc-board__band rc-board__band--${card.readiness.band}`}
              data-band={card.readiness.band}
            >
              {card.readiness.band === 'ready_to_submit' ? 'Ready to submit' : 'Needs action'}
            </span>
          )}
          {card.resume.locked && (
            <span className="rc-board__resume-lock" title="Submitted résumé (frozen)">
              Résumé locked
            </span>
          )}
          {card.rtr_state === 'NOT_EXECUTED' && (
            <span className="rc-board__rtr" title="Right to represent not executed">
              RTR needed
            </span>
          )}
          {card.days_in_stage != null && (
            <span className="rc-board__days">{card.days_in_stage}d in stage</span>
          )}
        </span>
        {card.readiness?.band === 'needs_action' && card.readiness.blockers.length > 0 && (
          <span className="rc-board__blockers">
            {card.readiness.blockers.map((b) => blockerLabel(b)).join(' · ')}
          </span>
        )}
      </Button>
      {performable.length > 0 && (
        <div className="rc-board__actions" aria-label={`Actions for ${name}`}>
          {performable.map((a) => (
            // The governed command executes in the owning drawer surface (TB-3 routes there;
            // TB-5 will drive the same projected command directly). The Board never
            // re-implements an owner command.
            <Button key={a.key} unstyled type="button" className="rc-board__action" onClick={onSelect} title={a.command_route}>
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
}: {
  column: BoardColumnView;
  talentNames: RequisitionTalentBoardProps['talentNames'];
  scopes: readonly string[];
  onSelectCard: (pipelineId: string) => void;
}): JSX.Element {
  // The Qualified column splits into its two readiness bands (§6); every other column is flat.
  const isQualified = column.key === 'qualified';
  const ready = isQualified ? column.cards.filter((c) => c.readiness?.band === 'ready_to_submit') : [];
  const needs = isQualified ? column.cards.filter((c) => c.readiness?.band !== 'ready_to_submit') : [];

  return (
    <section className="rc-board__col" aria-label={BOARD_COLUMN_LABELS[column.key]}>
      <header className="rc-board__col-head">
        <span className="rc-board__col-title">{BOARD_COLUMN_LABELS[column.key]}</span>
        <span className="rc-board__col-count">{column.count}</span>
      </header>
      <div className="rc-board__col-body">
        {column.count === 0 ? (
          <p className="rc-board__empty">—</p>
        ) : isQualified ? (
          <>
            {ready.length > 0 && (
              <div className="rc-board__band-group">
                <p className="rc-board__band-label">Ready to submit</p>
                {ready.map((c) => (
                  <BoardCard key={c.pipeline_id} card={c} name={talentLabel(talentNames, c.talent_record_id)} scopes={scopes} onSelect={() => onSelectCard(c.pipeline_id)} />
                ))}
              </div>
            )}
            {needs.length > 0 && (
              <div className="rc-board__band-group">
                <p className="rc-board__band-label">Needs action</p>
                {needs.map((c) => (
                  <BoardCard key={c.pipeline_id} card={c} name={talentLabel(talentNames, c.talent_record_id)} scopes={scopes} onSelect={() => onSelectCard(c.pipeline_id)} />
                ))}
              </div>
            )}
          </>
        ) : (
          column.cards.map((c) => (
            <BoardCard key={c.pipeline_id} card={c} name={talentLabel(talentNames, c.talent_record_id)} scopes={scopes} onSelect={() => onSelectCard(c.pipeline_id)} />
          ))
        )}
      </div>
    </section>
  );
}

export function RequisitionTalentBoard({ requisitionId, talentNames, onSelectCard, scopes = [] }: RequisitionTalentBoardProps): JSX.Element {
  const [board, setBoard] = useState<RequisitionTalentBoardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

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

  if (loading) return <p className="rc-board__status" role="status">Loading board…</p>;
  if (error.length > 0) return <p className="rc-board__status rc-board__status--error" role="alert">{error}</p>;
  if (board === null) return <p className="rc-board__status">No board.</p>;

  return (
    <div className="rc-board" aria-label="Talent board">
      <div className="rc-board__cols">
        {columns.map((col) => (
          <BoardColumn key={col.key} column={col} talentNames={talentNames} scopes={scopes} onSelectCard={onSelectCard} />
        ))}
      </div>
      {board.closed.total > 0 && (
        <details className="rc-board__closed">
          <summary className="rc-board__closed-summary">
            Closed <span className="rc-board__col-count">{board.closed.total}</span>
          </summary>
          <ul className="rc-board__closed-list">
            {board.closed.by_reason.map((r) => (
              <li key={r.reason} className="rc-board__closed-row">
                <span>{closedReasonLabel(r.reason)}</span>
                <span className="rc-board__col-count">{r.count}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
