import { Button } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';

import { initialsOf } from '../ui';

import {
  getRequisitionTalentBoard,
  BOARD_COLUMN_LABELS,
  BOARD_OWNER_LABELS,
  closedReasonLabel,
  blockerLabel,
  type BoardCardView,
  type BoardColumnKey,
  type BoardColumnView,
  type BoardOwner,
  type RequisitionTalentBoardView,
} from './requisition-talent-board-api';
import { governedDropTargets, resolveGovernedMove } from './board-governed-move';

// Requisition Talent Board (TB-2) — the read-only Board experience for Requisition Detail →
// Talent, pixel-matched to the approved prototype (platform/TalentBoard.dc.html). A projection
// surface only: it renders the backend-authoritative column placement, owner-attributed state,
// Closed disposition, resume linkage and Qualified band. It owns NO lifecycle truth and issues
// NO write — the governed next action + governed drag route to the owning drawer surface; the
// VOID (Remove from requisition) opens the shared confirmation. Clicking a card opens the SAME
// TalentDetailPanel drawer the List uses via `onSelectCard(pipeline_id)` (no second per-card
// fetch). STATE ENUMS ONLY — no compensation/bill/pay field is presented (DTO excludes it).

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

// The canonical owning function per column — used for the header lane tag, and to attribute an
// empty (backend-omitted) column the Board still renders. Mirrors the backend owner map.
const COLUMN_OWNER: Record<BoardColumnKey, BoardOwner> = {
  pipeline: 'pipeline',
  contacted: 'pipeline',
  qualified: 'pipeline',
  submitted: 'submittal',
  interview: 'client_selection',
  selected: 'client_selection',
  offer: 'offer',
  accepted: 'offer',
  prestart: 'placement',
  ready: 'placement',
  started: 'placement',
};

// Deterministic avatar tint from the talent id (presentation only — no data meaning). Mirrors
// the prototype's muted palette.
const AVATAR_TINTS = [
  '#3F6E8C', '#7A5A9C', '#4B7A5E', '#A0613A', '#5C6770', '#8A4B5E', '#2E5E8A',
  '#6A7F3A', '#9C5A3F', '#3A6B7A', '#8C6A2E', '#5A4B8A', '#2F7A63', '#7A3F55',
  '#3F5E8C', '#6B5A3A', '#6A4E8C', '#3F7A6A', '#4E7A8C',
];
function avatarTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length] ?? '#5C6770';
}

// Days-in-stage tone (authoritative stage-entry dwell; never a clock-read): 7d+ hot, 5d+ warn.
function ageTone(days: number): '' | 'warn' | 'hot' {
  if (days >= 7) return 'hot';
  if (days >= 5) return 'warn';
  return '';
}

// Resume-for-this-requisition linkage, from the authoritative selection source. The human
// edition LABEL is not on the board payload (LIVE-BUT-UNWIRED) — we surface selected / submitted
// / not-selected from `source`, never a fabricated label.
function resumeText(card: BoardCardView): string {
  if (card.resume.source === 'none') return 'Resume · not selected';
  if (card.resume.locked || card.resume.source === 'submitted_frozen') return 'Resume · submitted';
  return 'Resume · selected';
}

export interface RequisitionTalentBoardProps {
  readonly requisitionId: string;
  /** Talent display names keyed by talent_record_id (from the requisition's List load). */
  readonly talentNames?: Readonly<Record<string, string | undefined>>;
  /** Talent role · company subtitle keyed by talent_record_id (from the loaded talents map). */
  readonly talentSubtitles?: Readonly<Record<string, string | undefined>>;
  /** User directory display names keyed by user_id — resolves the assigned recruiter to initials. */
  readonly recruiterNames?: Readonly<Record<string, string | undefined>>;
  /** Open the shared TalentDetailPanel drawer for a card's pipeline episode. */
  readonly onSelectCard: (pipelineId: string) => void;
  /** The actor's scopes — the Board hides a next action the actor cannot perform (TB-3).
   *  UI hiding is never the boundary: the server re-authorizes every governed command. */
  readonly scopes?: readonly string[];
  /** Accidental-Add Correction — open the "Remove from requisition" confirmation for a card.
   *  The action is projected by the server (pipeline.void in next_actions); this only opens
   *  the confirmation. */
  readonly onRequestVoid?: (pipelineId: string, talentName: string) => void;
  /** Bump to force a re-fetch (e.g. after a successful VOID removes a card). */
  readonly refreshToken?: unknown;
}

function talentLabel(names: RequisitionTalentBoardProps['talentNames'], id: string): string {
  const n = names?.[id];
  if (n !== undefined && n.trim().length > 0) return n;
  return `Talent ${id.slice(0, 8)}`;
}

// A bounded line-icon for the resume row + the ⋯ menu (stroked, inherits colour).
function ResumeIcon(): JSX.Element {
  return (
    <svg
      className="rc-tboard__resume-ic"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5" />
    </svg>
  );
}

function BoardCard({
  card,
  name,
  subtitle,
  recruiterName,
  scopes,
  onSelect,
  onDragStart,
  onDragEnd,
  onRequestVoid,
}: {
  card: BoardCardView;
  name: string;
  subtitle?: string;
  recruiterName?: string;
  scopes: readonly string[];
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onRequestVoid?: (pipelineId: string, talentName: string) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  // Scope-gate the projected next actions (TB-3): only actions the actor can perform. The server
  // re-authorizes on execution — this is presentation, not the boundary. The VOID action is
  // separated: a destructive correction living in the ⋯ menu, not the primary footer action.
  const performable = card.next_actions.filter(
    (a) => scopes.includes(a.required_scope) && a.key !== 'pipeline.void',
  );
  const voidAction = card.next_actions.find(
    (a) => a.key === 'pipeline.void' && scopes.includes(a.required_scope),
  );
  const primary = performable[0];

  // Footer waiting text when the actor has no primary action (GAP — composed FE-side; the board
  // emits no waiting string): a downstream handoff card is TRACKED read-only; a card with actions
  // the actor cannot perform is awaiting its owner; otherwise nothing.
  const firstAction = card.next_actions[0];
  const waiting = card.handoff
    ? `Tracking · ${BOARD_OWNER_LABELS[card.owner]}`
    : primary === undefined && firstAction !== undefined
      ? `Next: ${BOARD_OWNER_LABELS[firstAction.owner]}`
      : '';

  // Authoritative fact pills: RTR (binary — only NOT_EXECUTED is knowable; Sent/Confirmed is not
  // on the substrate) and the Qualified-band Missing-requirements (readiness.blockers). No
  // Email/Voice (GAP — no channel signal at board grain) and no pay (comp excluded from the DTO).
  const missing =
    card.readiness?.band === 'needs_action' && card.readiness.blockers.length > 0
      ? `Missing: ${card.readiness.blockers.map((b) => blockerLabel(b)).join(', ')}`
      : '';

  const recruiterInitials =
    card.assigned_recruiter_user_id !== null && recruiterName !== undefined && recruiterName.trim().length > 0
      ? initialsOf(recruiterName)
      : '';

  return (
    <div
      className={`rc-tboard__card${card.handoff ? ' rc-tboard__card--tracked' : ''}`}
      draggable={!card.handoff}
      onDragStart={card.handoff ? undefined : (e) => { e.dataTransfer?.setData?.('text/plain', card.pipeline_id); onDragStart(); }}
      onDragEnd={card.handoff ? undefined : onDragEnd}
    >
      <Button unstyled type="button" className="rc-tboard__card-open" onClick={onSelect} aria-label={`Open ${name}`}>
        <span className="rc-tboard__card-id">
          <span className="rc-tboard__avatar" style={{ background: avatarTint(card.talent_record_id) }} aria-hidden="true">
            {initialsOf(name)}
          </span>
          <span className="rc-tboard__card-idtext">
            <span className="rc-tboard__card-name">{name}</span>
            {subtitle !== undefined && subtitle.length > 0 && (
              <span className="rc-tboard__card-sub">{subtitle}</span>
            )}
          </span>
          {card.days_in_stage != null && (
            <span className={`rc-tboard__days${ageTone(card.days_in_stage) ? ` rc-tboard__days--${ageTone(card.days_in_stage)}` : ''}`} title="Days in stage">
              {card.days_in_stage}d
            </span>
          )}
        </span>
        <span className="rc-tboard__resume">
          <ResumeIcon />
          <span className="rc-tboard__resume-txt">{resumeText(card)}</span>
        </span>
        {(card.rtr_state === 'NOT_EXECUTED' || missing.length > 0) && (
          <span className="rc-tboard__facts">
            {card.rtr_state === 'NOT_EXECUTED' && (
              <span className="rc-tboard__pill rc-tboard__pill--mute">RTR · Not sent</span>
            )}
            {missing.length > 0 && (
              <span className="rc-tboard__pill rc-tboard__pill--bad" title={missing}>{missing}</span>
            )}
          </span>
        )}
      </Button>

      <div className="rc-tboard__foot">
        {primary !== undefined ? (
          // The governed command executes in the owning drawer surface (TB-3 routes there). The
          // Board never re-implements an owner command.
          <Button unstyled type="button" className="rc-tboard__act-btn" onClick={onSelect} title={primary.command_route}>
            {primary.label}
          </Button>
        ) : waiting.length > 0 ? (
          <span className="rc-tboard__wait">{waiting}</span>
        ) : null}
        <span className="rc-tboard__foot-end">
        {recruiterInitials.length > 0 && (
          <span className="rc-tboard__rec" title={recruiterName}>{recruiterInitials}</span>
        )}
        <span className="rc-tboard__menu">
          <Button
            unstyled
            type="button"
            className="rc-tboard__menu-btn"
            aria-label={`More actions for ${name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </Button>
          {menuOpen && (
            <>
              <Button
                unstyled
                type="button"
                className="rc-tboard__menu-scrim"
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
              />
              <span className="rc-tboard__menu-pop">
                <Button
                  unstyled
                  type="button"
                  className="rc-tboard__menu-item"
                  onClick={() => { setMenuOpen(false); onSelect(); }}
                >
                  View talent
                </Button>
                {voidAction !== undefined && onRequestVoid !== undefined && (
                  <>
                    <span className="rc-tboard__menu-div" />
                    <Button
                      unstyled
                      type="button"
                      className="rc-tboard__menu-item rc-tboard__menu-item--danger"
                      onClick={() => { setMenuOpen(false); onRequestVoid(card.pipeline_id, name); }}
                      title={voidAction.command_route}
                    >
                      {voidAction.label}
                    </Button>
                  </>
                )}
              </span>
            </>
          )}
        </span>
        </span>
      </div>
    </div>
  );
}

function BoardColumn({
  column,
  talentNames,
  talentSubtitles,
  recruiterNames,
  scopes,
  onSelectCard,
  isDropTarget,
  onDragStartCard,
  onDragEndCard,
  onDropCard,
  onRequestVoid,
}: {
  column: BoardColumnView;
  talentNames: RequisitionTalentBoardProps['talentNames'];
  talentSubtitles: RequisitionTalentBoardProps['talentSubtitles'];
  recruiterNames: RequisitionTalentBoardProps['recruiterNames'];
  scopes: readonly string[];
  onSelectCard: (pipelineId: string) => void;
  isDropTarget: boolean;
  onDragStartCard: (card: BoardCardView) => void;
  onDragEndCard: () => void;
  onDropCard: (targetColumn: BoardColumnKey) => void;
  onRequestVoid?: (pipelineId: string, talentName: string) => void;
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
      subtitle={talentSubtitles?.[c.talent_record_id]}
      recruiterName={c.assigned_recruiter_user_id !== null ? recruiterNames?.[c.assigned_recruiter_user_id] : undefined}
      scopes={scopes}
      onSelect={() => onSelectCard(c.pipeline_id)}
      onDragStart={() => onDragStartCard(c)}
      onDragEnd={onDragEndCard}
      onRequestVoid={onRequestVoid}
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
      {/* Lane tag (prototype's persona-relative YOUR LANE / INCOMING / TRACKING) is intentionally
          OMITTED: production has no authoritative per-viewer lane-ownership model, and the
          absolute column owner is a semantically DIFFERENT concept — surfacing it would misrepresent
          the prototype. Recorded as a typed GAP (future product/backend authority). Never FE-derived. */}
      <header className="rc-tboard__col-head">
        <span className="rc-tboard__col-dot" aria-hidden="true" />
        <span className="rc-tboard__col-title">{BOARD_COLUMN_LABELS[column.key]}</span>
        <span className="rc-tboard__col-count">{column.count}</span>
      </header>
      <div className="rc-tboard__col-body">
        {column.count === 0 ? (
          <p className="rc-tboard__empty">Nothing here</p>
        ) : isQualified ? (
          <>
            {ready.length > 0 && (
              <div className="rc-tboard__band-group">
                <p className="rc-tboard__band-label rc-tboard__band-label--ready">Ready to submit · {ready.length}</p>
                {ready.map(renderCard)}
              </div>
            )}
            {needs.length > 0 && (
              <div className="rc-tboard__band-group">
                <p className="rc-tboard__band-label rc-tboard__band-label--needs">Needs action · {needs.length}</p>
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

export function RequisitionTalentBoard({ requisitionId, talentNames, talentSubtitles, recruiterNames, onSelectCard, scopes = [], onRequestVoid, refreshToken }: RequisitionTalentBoardProps): JSX.Element {
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
  }, [requisitionId, refreshToken]);

  // Render every column in canonical order, even when the backend omitted an empty one.
  const columns = useMemo(() => {
    const byKey = new Map((board?.columns ?? []).map((c) => [c.key, c]));
    return COLUMN_ORDER.map(
      (key): BoardColumnView => byKey.get(key) ?? { key, owner: COLUMN_OWNER[key], count: 0, cards: [] },
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
            talentSubtitles={talentSubtitles}
            recruiterNames={recruiterNames}
            scopes={scopes}
            onSelectCard={onSelectCard}
            isDropTarget={validTargets?.has(col.key) ?? false}
            onDragStartCard={setDragging}
            onDragEndCard={() => setDragging(null)}
            onDropCard={onDropCard}
            onRequestVoid={onRequestVoid}
          />
        ))}
        <aside className="rc-tboard__closed" aria-label="Closed">
          <p className="rc-tboard__closed-title">Closed</p>
          {(board.closed?.total ?? 0) > 0 ? (
            <ul className="rc-tboard__closed-list">
              {(board.closed?.by_reason ?? []).map((r) => (
                <li key={r.reason} className="rc-tboard__closed-row">
                  <span>{closedReasonLabel(r.reason)}</span>
                  <span className="rc-tboard__closed-count"> · {r.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rc-tboard__closed-empty">Nothing here</p>
          )}
        </aside>
      </div>
    </div>
  );
}
