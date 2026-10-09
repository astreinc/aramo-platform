import { Button } from '@aramo/fe-foundation';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { ActivityView } from '../activity/types';
import type { InterviewCalendarRow } from '../interviews/interviews-api';
import type { PipelineView } from '../pipeline/types';
import type { PlacementView } from '../placement/types';
import type { TalentRecordView } from '../talent/types';
import type { TaskView } from '../task/types';
import { TASK_ACTIVE_STATUS_VALUES } from '../task/types';

import { AddTalentDialog } from './AddTalentDialog';
import { RequisitionTalentBoard } from './RequisitionTalentBoard';
import { TalentViewToggle } from './TalentViewToggle';
import {
  BOARD_COLUMN_LABELS,
  blockerLabel,
  type BoardCardView,
  type BoardColumnKey,
  type RequisitionTalentBoardView,
} from './requisition-talent-board-api';
import { useRequisitionTalentActions } from './requisition-talent-actions';
import type { TalentView } from './useTalentViewPreference';
import type { RequisitionView } from './types';
import type { AttentionItem, TabId } from './RequisitionDetailView';

// Requisition WORKSPACE — the operational, do-the-work projection that opens
// first. It COMPOSES already-fetched requisition-grain reads (the Talent Board,
// the eager offers/placements-derived attention, the interview calendar window,
// requisition tasks, the merged activity feed) into six grounded sections. It
// invents NO new backend state, lifecycle rule or policy layer: every count,
// stage, readiness band and blocker is the backend's; every CTA rides an
// EXISTING scope (least-visibility — hidden, never disabled) and navigates to
// the already-governed surface rather than reimplementing a transition.
//
// Layout (prototype parity) — a flex wrapper that wraps the rail BELOW the main
// column on narrow viewports. MAIN (wide) = Needs attention / Pipeline / Talent
// in play; RAIL (narrow) = Requisition context / Upcoming & tasks / Recent
// activity.

interface WorkspacePanelProps {
  readonly req: RequisitionView;
  readonly companyName: string | null;
  readonly contactName: string | null;
  // Recruiter display name, resolved from req.recruiter_id via the directory.
  // Account manager is DELIBERATELY omitted — there is no modeled source for it
  // (owner_id semantics are disavowed and the assignment model is role-less), so
  // the only modeled ownership role shown here is Recruiter. The prototype shows
  // an "Account manager" row; it is reported as a backend/model gap, never faked.
  readonly recruiterName: string | null;
  readonly locationLabel: string;
  readonly arrangementLabel: string | null;
  readonly board: RequisitionTalentBoardView | null;
  readonly talentNames: Record<string, string>;
  // Directory-resolved display names for task owners / activity actors, keyed by
  // user id. Unresolved ids fall back to the neutral 'Unknown user' label — a
  // raw UUID is NEVER rendered.
  readonly userNames: Record<string, string>;
  readonly interviews: readonly InterviewCalendarRow[];
  readonly tasks: readonly TaskView[];
  readonly canReadTasks: boolean;
  readonly activities: readonly ActivityView[];
  readonly attentionItems: readonly AttentionItem[];
  readonly scopes: readonly string[];
  readonly existingTalentIds: readonly string[];
  readonly canAddTalent: boolean;
  readonly canSource: boolean;
  // Talent-in-play embedded Board (the SAME board + drawer + VOID context as the
  // Talent tab, via the shared hook) and the shared List|Board preference.
  readonly pipelines: readonly PipelineView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly placements: readonly PlacementView[];
  readonly canEditHot: boolean;
  readonly canReadPlacements: boolean;
  readonly onToggleHot: (talentId: string, next: boolean) => Promise<void>;
  readonly onPipelineUpdated: (updated: PipelineView) => void;
  readonly onPipelineRemoved: (pipelineId: string) => void;
  readonly talentView: TalentView;
  readonly onTalentView: (next: TalentView) => void;
  readonly onNavigate: (tab: TabId) => void;
  readonly onRefresh: () => void;
}

// Terminal interview states are not "upcoming"; the calendar window already
// bounds the range, so we only drop the done/aborted ones.
const UPCOMING_INTERVIEW_STATES = new Set(['SCHEDULED', 'RESCHEDULED']);

// The five ACTIVE recruiting stages — mirrors libs/pipeline ACTIVE_FLOW_STAGES
// (a hand-mirror, not an import: ats-web does not depend on libs/pipeline). The
// tile counts read card.owner_state, which is the verbatim pipeline status while
// owner==='pipeline' (backend Rule D — never re-derived). Pipeline owns these
// recruiting stages ONLY; downstream journey stages live on the Talent board.
const PIPELINE_STAGES: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'no_contact', label: 'No contact' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'talent_responded', label: 'Talent responded' },
  { key: 'qualifying', label: 'Qualifying' },
  { key: 'qualified', label: 'Qualified' },
];

// Funnel ordinal of an active recruiting stage (index into PIPELINE_STAGES);
// -1 when the status is terminal / not an active-flow stage.
const activeOrdinal = (state: string): number =>
  PIPELINE_STAGES.findIndex((s) => s.key === state);

export function WorkspacePanel({
  req,
  companyName,
  contactName,
  recruiterName,
  locationLabel,
  arrangementLabel,
  board,
  talentNames,
  userNames,
  interviews,
  tasks,
  canReadTasks,
  activities,
  attentionItems,
  scopes,
  existingTalentIds,
  canAddTalent,
  canSource,
  pipelines,
  talents,
  placements,
  canEditHot,
  canReadPlacements,
  onToggleHot,
  onPipelineUpdated,
  onPipelineRemoved,
  talentView,
  onTalentView,
  onNavigate,
  onRefresh,
}: WorkspacePanelProps) {
  const columns = board?.columns ?? [];
  const cards: readonly BoardCardView[] = columns.flatMap((c) => c.cards);
  // The List view renders the four funnel column labels ONCE in a header row.
  // Derive them from the first card so the header order matches the per-row
  // funnelCells() order exactly (Contact · Qualification · RTR · Client).
  const firstCard = cards[0];
  const funnelLabels =
    firstCard !== undefined ? funnelCells(firstCard).map((c) => c.label) : [];
  const [findOpen, setFindOpen] = useState(false);

  // The SAME talent action context the Talent tab uses (shared hook) — so the
  // embedded Board's card-click drawer + Remove-from-requisition VOID behave
  // identically, with no duplicated handlers and no second board.
  const talentActions = useRequisitionTalentActions({
    req,
    pipelines,
    talents,
    placements,
    scopes,
    canEditHot,
    canReadPlacements,
    userNames,
    onToggleHot,
    onPipelineUpdated,
    onPipelineRemoved,
  });

  // Board-derived attention: a talent in a Qualified-band 'needs_action' card
  // carries one or more authoritative blockers. Tally by blocker so the section
  // surfaces the SAME grounded truth the Board shows (optional, additive to the
  // existing grounded rail set — nothing unmodeled is invented).
  const blockerCounts = new Map<string, number>();
  for (const c of cards) {
    if (c.readiness?.band !== 'needs_action') continue;
    for (const b of c.readiness.blockers) {
      blockerCounts.set(b, (blockerCounts.get(b) ?? 0) + 1);
    }
  }
  const allAttn: AttentionItem[] = [
    ...attentionItems,
    ...[...blockerCounts.entries()].map(([b, count]) => ({
      key: `blocker-${b}`,
      tone: 'amber' as const,
      what: blockerLabel(b),
      detail: `${count} talent in pipeline`,
      linkLabel: 'Talent →',
      target: 'talent' as TabId,
    })),
  ];
  // Needs attention shows only items worth interrupting for (max 5); the rest
  // roll up into a single "+N more" row that opens the Talent tab.
  const attn = allAttn.slice(0, 5);
  const attnMore = allAttn.length - attn.length;

  const inPlay = board?.total_active ?? cards.length;
  const colCount = (key: BoardColumnKey): number =>
    columns.find((c) => c.key === key)?.count ?? 0;
  // Pipeline tile counts. The backend collapses the 5 recruiting statuses into 3
  // columns (pipeline=no_contact, contacted={contacted,talent_responded,
  // qualifying}, qualified). The two 1:1 tiles read the authoritative column
  // count; the three tiles inside the `contacted` column are split by per-card
  // owner_state (a pipeline status only while owner==='pipeline'). All counts are
  // the backend's — nothing is invented.
  const cardStageCount = (stage: string): number =>
    cards.filter((c) => c.owner === 'pipeline' && c.owner_state === stage).length;
  const stageCount = (stage: string): number => {
    if (stage === 'no_contact') return colCount('pipeline');
    if (stage === 'qualified') return colCount('qualified');
    return cardStageCount(stage);
  };
  const withClient = {
    submitted: colCount('submitted'),
    interview: colCount('interview'),
    offer: colCount('offer'),
  };

  const upcoming = [...interviews]
    .filter((iv) => UPCOMING_INTERVIEW_STATES.has(iv.state))
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
    .slice(0, 5);

  const openTasks = tasks
    .filter((t) => (TASK_ACTIVE_STATUS_VALUES as readonly string[]).includes(t.status))
    .slice(0, 5);

  const recent = [...activities].slice(0, 5);

  // Latest client note — SOFT-DERIVED from the most recent requisition activity
  // tagged CLIENT_INTERACTION with a non-empty body (there is no first-class
  // "latest client note" field). Honest empty state otherwise.
  const latestClientNote =
    activities.find(
      (a) =>
        a.category === 'CLIENT_INTERACTION' &&
        a.notes !== null &&
        a.notes.trim() !== '' &&
        a.redacted_at === null,
    )?.notes ?? null;

  const nameOf = (id: string): string => talentNames[id] ?? 'Talent';
  const userName = (id: string | null): string =>
    id !== null ? (userNames[id] ?? 'Unknown user') : 'Unknown user';

  const filled = Math.max(0, req.openings - req.openings_available);
  const locationValue = [locationLabel, arrangementLabel]
    .filter((s): s is string => s !== null && s !== '')
    .join(' · ');

  return (
    <div className="rc-ws">
      {/* ── MAIN column (wide) ─────────────────────────────────────────── */}
      <div className="rc-ws__main">
        {/* 2.1 Needs attention — the only raised card on the tab. */}
        <div className="rc-card rc-attn-card">
          <div className="rc-attn-card__head">
            <h2>Needs attention</h2>
            {attn.length > 0 ? (
              <span className="rc-attn-card__count">{attn.length}</span>
            ) : null}
          </div>
          <p className="rc-attn-card__sub">
            Worked out from live requisition and talent state · most urgent first ·
            clears once resolved.
          </p>
          {attn.length === 0 ? (
            <div className="rc-attn-card__empty">
              Nothing needs attention on this requisition right now.
            </div>
          ) : (
            <>
              {attn.map((item) => (
                <div key={item.key} className="rc-attn__row">
                  <span
                    className={`rc-attn__dot rc-attn__dot--${item.tone}`}
                    aria-hidden="true"
                  />
                  <span className="rc-attn__body">
                    <b>{item.what}</b>
                    {item.detail !== undefined ? (
                      <span className="rc-attn__detail">{item.detail}</span>
                    ) : null}
                  </span>
                  <Button
                    unstyled
                    type="button"
                    className="rc-btn-outline rc-attn__cta"
                    onClick={() => onNavigate(item.target)}
                  >
                    {item.linkLabel}
                  </Button>
                </div>
              ))}
              {attnMore > 0 ? (
                <div className="rc-attn__more">
                  {attnMore} more on talent{' '}
                  <Button
                    unstyled
                    type="button"
                    className="rc-link"
                    onClick={() => onNavigate('talent')}
                  >
                    Open Talent →
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* 2.2 Pipeline — horizontal 5-stage strip + With-the-client line. */}
        <div className="rc-card rc-pipe">
          <div className="rc-pipe__head">
            <h2>Pipeline</h2>
            <span className="rc-pipe__inplay">{inPlay} in play</span>
            <span className="rc-pipe__find">
              {canAddTalent || canSource ? (
                <Button
                  unstyled
                  type="button"
                  className="rc-btn-outline rc-pipe__findbtn"
                  onClick={() => setFindOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={findOpen}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="M20 20l-3.5-3.5" />
                  </svg>
                  Find talent
                </Button>
              ) : null}
              {findOpen ? (
                <>
                  <span
                    className="rc-pipe__findscrim"
                    onClick={() => setFindOpen(false)}
                    aria-hidden="true"
                  />
                  <span className="rc-pipe__findmenu" role="menu">
                    <span className="rc-pipe__findhead">
                      FIND TALENT FOR REQ-{req.requisition_number}
                    </span>
                    {canAddTalent ? (
                      <span className="rc-pipe__findknown" role="menuitem">
                        <AddTalentDialog
                          requisitionId={req.id}
                          existingTalentIds={existingTalentIds}
                          onAdded={() => {
                            setFindOpen(false);
                            onRefresh();
                          }}
                        />
                      </span>
                    ) : null}
                    {canSource ? (
                      <Link
                        to={`/sourcing?req=${req.id}`}
                        className="rc-pipe__finditem"
                        role="menuitem"
                        onClick={() => setFindOpen(false)}
                      >
                        <span className="rc-pipe__finditem-t">Source new talent</span>
                        <span className="rc-pipe__finditem-s">
                          Bring in new people via Sourcing.
                        </span>
                      </Link>
                    ) : null}
                  </span>
                </>
              ) : null}
            </span>
            <Button
              unstyled
              type="button"
              className="rc-link rc-pipe__opentalent"
              onClick={() => onNavigate('talent')}
            >
              Open Talent →
            </Button>
          </div>
          <div className="rc-pipe__strip">
            {PIPELINE_STAGES.map((s) => {
              const n = stageCount(s.key);
              return (
                <Button
                  unstyled
                  key={s.key}
                  type="button"
                  className={`rc-pipe__tile${n > 0 ? ' rc-pipe__tile--on' : ''}`}
                  onClick={() => onNavigate('talent')}
                  title={`${s.label}: ${n}`}
                >
                  <span className="rc-pipe__tile-n">{n}</span>
                  <span className="rc-pipe__tile-l">{s.label}</span>
                </Button>
              );
            })}
          </div>
          <div className="rc-pipe__client">
            <b>With the client</b>
            <span>
              {withClient.submitted} submitted to client · {withClient.interview}{' '}
              interview · {withClient.offer} offer
            </span>
            <span className="rc-pipe__client-src">
              · from Submittals and client selection
            </span>
          </div>
        </div>

        {/* 2.3 Talent in play — Board (default) or List, sharing the same board
            + drawer + VOID context as the Talent tab and the shared preference. */}
        <div className="rc-card rc-tip">
          <div className="rc-tip__head">
            <h2>Talent in play</h2>
            <span className="rc-tip__hint">
              Where each person is and what the next step needs
            </span>
            <TalentViewToggle value={talentView} onChange={onTalentView} />
          </div>
          {talentView === 'board' ? (
            <div className="rc-tip__board">
              <RequisitionTalentBoard
                requisitionId={req.id}
                talentNames={talentActions.boardTalentNames}
                talentSubtitles={talentActions.boardTalentSubtitles}
                recruiterNames={talentActions.boardRecruiterNames}
                scopes={scopes}
                onSelectCard={(pid) => {
                  const p = pipelines.find((x) => x.id === pid);
                  if (p !== undefined) talentActions.openRow(p);
                }}
                onRequestVoid={talentActions.requestVoid}
                refreshToken={talentActions.boardRefresh}
              />
            </div>
          ) : cards.length === 0 ? (
            <div className="rc-tip__empty">
              <p className="rc-empty">No talent in play yet.</p>
              {canAddTalent ? (
                <div className="rc-mt-8">
                  <AddTalentDialog
                    requisitionId={req.id}
                    existingTalentIds={existingTalentIds}
                    onAdded={onRefresh}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            // List = a single-header table (prototype parity). The column labels
            // render ONCE in the header; each data row renders value-only cells
            // beneath them, sharing the same grid template. Narrow panels scroll
            // sideways (min-width) rather than wrapping rows into stacked cards
            // that repeat the labels. Zero rows → empty state above, no header.
            <div className="rc-tip__list">
              <div className="rc-tip__ltable">
                <div className="rc-tip__lhead" role="row">
                  <span className="rc-tip__lh">Talent</span>
                  {funnelLabels.map((label) => (
                    <span key={label} className="rc-tip__lh">
                      {label}
                    </span>
                  ))}
                  <span className="rc-tip__lh rc-tip__lh--end">Next step</span>
                </div>
                {cards.map((card) => (
                  <TalentInPlayRow
                    key={card.pipeline_id}
                    card={card}
                    name={nameOf(card.talent_record_id)}
                    scopes={scopes}
                    onOpen={() => onNavigate('talent')}
                  />
                ))}
              </div>
            </div>
          )}
          {talentActions.portals}
        </div>
      </div>

      {/* ── RIGHT rail (narrow) ────────────────────────────────────────── */}
      <div className="rc-ws__rail">
        {/* 2.4 Requisition context — compact fact card. */}
        <div className="rc-card rc-ctx">
          <div className="rc-ctx__head">
            <h2>Requisition context</h2>
            <Button
              unstyled
              type="button"
              className="rc-link"
              onClick={() => onNavigate('overview')}
            >
              All details →
            </Button>
          </div>
          <div className="rc-ctx__facts">
            <Fact label="Client" value={companyName ?? 'Client'} />
            <Fact label="Openings" value={`${req.openings} · ${filled} filled`} />
            {locationValue !== '' ? (
              <Fact label="Location" value={locationValue} />
            ) : null}
            <Fact label="Age" value={`${daysOpen(req.created_at)} days`} />
            <Fact
              label="Start date"
              value={req.start_date !== null ? formatDate(req.start_date) : 'Not set'}
              tone={req.start_date !== null ? undefined : 'warn'}
            />
            <Fact
              label="Hiring contact"
              value={contactName ?? 'None recorded'}
              tone={contactName !== null ? undefined : 'warn'}
            />
            <Fact label="Recruiter" value={recruiterName ?? 'Not assigned'} />
            {/* Account manager row omitted — no modeled source (role-less
                assignment model; owner_id semantics disavowed). Reported as a
                typed backend/model divergence, never faked. */}
          </div>
          <div className="rc-ctx__note">
            <div className="rc-caps">LATEST CLIENT NOTE</div>
            {latestClientNote !== null ? (
              <div className="rc-ctx__note-body">{latestClientNote}</div>
            ) : (
              <div className="rc-ctx__note-empty">No hiring-manager notes yet</div>
            )}
          </div>
        </div>

        {/* 2.5 Upcoming & tasks. */}
        <div className="rc-card rc-up">
          <h2 className="rc-up__title">Upcoming &amp; tasks</h2>
          <div className="rc-caps">INTERVIEWS</div>
          {upcoming.length === 0 ? (
            <p className="rc-up__none">None scheduled</p>
          ) : (
            <ul className="rc-up__list">
              {upcoming.map((iv) => (
                <li key={iv.id} className="rc-up__iv">
                  <span className="rc-up__iv-nm">{iv.talent_name ?? 'Talent'}</span>
                  <span className="rc-up__iv-when">{formatDate(iv.scheduled_at)}</span>
                </li>
              ))}
            </ul>
          )}
          {canReadTasks ? (
            <>
              <div className="rc-up__taskhead">
                <span className="rc-caps">TASKS · FROM PEOPLE</span>
                <Button
                  unstyled
                  type="button"
                  className="rc-link"
                  onClick={() => onNavigate('tasks')}
                >
                  All tasks →
                </Button>
              </div>
              {openTasks.length === 0 ? (
                <p className="rc-up__none">No open tasks.</p>
              ) : (
                openTasks.map((t) => {
                  const due = t.due_date !== null ? isToday(t.due_date) : false;
                  return (
                    <div key={t.id} className="rc-task">
                      <span className="rc-task__box" aria-hidden="true" />
                      <span className="rc-task__body">
                        <b>{t.title}</b>
                        <span className="rc-task__meta">
                          owned by {userName(t.assignee_id ?? t.created_by_user_id)}
                          {t.due_date !== null ? (
                            due ? (
                              <>
                                {' · '}
                                <b className="rc-task__due">due today</b>
                              </>
                            ) : (
                              <> · due {formatDate(t.due_date)}</>
                            )
                          ) : null}
                        </span>
                      </span>
                    </div>
                  );
                })
              )}
            </>
          ) : null}
        </div>

        {/* 2.6 Recent activity — View all is a text link; Log note is in the
            page header, not this card. */}
        <div className="rc-card rc-act">
          <div className="rc-act__head">
            <h2>Recent activity</h2>
            <Button
              unstyled
              type="button"
              className="rc-link"
              onClick={() => onNavigate('activity')}
            >
              View all →
            </Button>
          </div>
          {recent.length === 0 ? (
            <p className="rc-empty">No activity yet.</p>
          ) : (
            recent.map((a) => (
              <div key={a.id} className="rc-act__row">
                <span
                  className={`rc-act__dot rc-act__dot--${activityTone(a)}`}
                  aria-hidden="true"
                />
                <span className="rc-act__body">
                  <b>{activityTitle(a)}</b>
                  <span className="rc-act__detail">{activityDetail(a, userName)}</span>
                </span>
                <span className="rc-act__when">{formatDate(a.created_at)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// One Talent-in-play row — avatar + name (→ Talent 360) + stage pill + age, a
// four-milestone funnel grid (Contact · Qualification · RTR · Client, all READ
// projections of the single authoritative owner_state/rtr_state — no parallel FE
// stage model), and the single next action the actor is authorised for
// (least-visibility). The grid is a display projection, not independent state.
function TalentInPlayRow({
  card,
  name,
  scopes,
  onOpen,
}: {
  readonly card: BoardCardView;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly onOpen: () => void;
}) {
  const action = card.next_actions.find(
    (a) => a.key !== 'pipeline.void' && scopes.includes(a.required_scope),
  );
  const stageLabel =
    card.owner === 'pipeline'
      ? (PIPELINE_STAGES.find((s) => s.key === card.owner_state)?.label ??
        BOARD_COLUMN_LABELS[card.column])
      : BOARD_COLUMN_LABELS[card.column];
  const cells = funnelCells(card);

  return (
    <div className="rc-tip__row" role="row">
      <span className="rc-tip__person">
        <span className="rc-avatar" aria-hidden="true">
          {initials(name)}
        </span>
        <span className="rc-tip__id">
          <Link to={`/talent/${card.talent_record_id}`} className="rc-tip__name">
            {name}
          </Link>
          <span className="rc-tip__sub">
            <span className="rc-stage-pill">{stageLabel}</span>
            <span className={`rc-tip__age${isStale(card) ? ' rc-tip__age--warn' : ''}`}>
              {ageLabel(card)}
            </span>
          </span>
        </span>
      </span>
      {/* Value-only cells — the column labels live once in the header row. */}
      {cells.map((c) => (
        <span key={c.label} className="rc-tip__cell">
          <span className={`rc-tip__val rc-tip__val--${c.tone}`}>{c.value}</span>
        </span>
      ))}
      <span className="rc-tip__next">
        {action !== undefined ? (
          <Button
            unstyled
            type="button"
            className="rc-btn-primary rc-tip__cta"
            onClick={onOpen}
          >
            {action.label}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

type CellTone = 'ok' | 'warn' | 'bad' | 'mute';

// The four funnel milestones, each a read projection of the single authoritative
// stage (owner / owner_state) plus rtr_state. We NEVER assert a milestone we
// cannot ground: RTR is 'Required' only when the backend flagged it NOT_EXECUTED,
// otherwise '—' (null does not prove executed).
function funnelCells(
  card: BoardCardView,
): ReadonlyArray<{ label: string; value: string; tone: CellTone }> {
  const downstream = card.owner !== 'pipeline';
  const ord = activeOrdinal(card.owner_state);

  const contact: { value: string; tone: CellTone } = downstream
    ? { value: '✓ Complete', tone: 'ok' }
    : card.owner_state === 'no_contact'
      ? { value: 'Not contacted', tone: 'bad' }
      : { value: '✓ Complete', tone: 'ok' };

  const qualification: { value: string; tone: CellTone } = downstream
    ? { value: '✓ Complete', tone: 'ok' }
    : card.owner_state === 'qualified'
      ? { value: '✓ Complete', tone: 'ok' }
      : ord >= activeOrdinal('qualifying')
        ? { value: 'In progress', tone: 'warn' }
        : { value: '—', tone: 'mute' };

  const rtr: { value: string; tone: CellTone } =
    card.rtr_state === 'NOT_EXECUTED'
      ? { value: 'Required', tone: 'bad' }
      : { value: '—', tone: 'mute' };

  const client: { value: string; tone: CellTone } = !downstream
    ? { value: 'Not submitted', tone: 'mute' }
    : card.owner === 'submittal'
      ? { value: 'Submitted', tone: 'ok' }
      : card.owner === 'client_selection'
        ? { value: 'With client', tone: 'ok' }
        : card.owner === 'offer'
          ? { value: 'Offer', tone: 'ok' }
          : { value: 'Placed', tone: 'ok' };

  return [
    { label: 'Contact', ...contact },
    { label: 'Qualification', ...qualification },
    { label: 'RTR', ...rtr },
    { label: 'Client', ...client },
  ];
}

function ageLabel(card: BoardCardView): string {
  const d = card.days_in_stage;
  if (d === null) return card.owner === 'pipeline' ? 'not submitted' : 'in stage';
  const days = `${d} day${d === 1 ? '' : 's'}`;
  if (card.owner_state === 'no_contact') return `${days} since added`;
  if (card.owner === 'pipeline') return `${days} · not submitted`;
  return `${days} in stage`;
}

function isStale(card: BoardCardView): boolean {
  return card.days_in_stage !== null && card.days_in_stage > 7;
}

function Fact({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'warn';
}) {
  return (
    <div className="rc-ctx__row">
      <span className="rc-ctx__k">{label}</span>
      <b className={`rc-ctx__v${tone !== undefined ? ` rc-ctx__v--${tone}` : ''}`}>
        {value}
      </b>
    </div>
  );
}

// Title/detail/tone for a recent-activity row. Actor names come from the
// directory map (never a UUID); the subject talent is not plumbed onto the
// activity, so detail is the note body or a neutral "by <actor>" line.
function activityTitle(a: ActivityView): string {
  if (a.type === 'note' && a.notes !== null && a.notes.trim() !== '') {
    return a.category !== null
      ? labelCategory(a.category)
      : 'Note';
  }
  switch (a.type) {
    case 'pipeline_status_change':
      return 'Stage change';
    case 'call':
      return 'Call logged';
    case 'email_logged':
      return 'Email logged';
    default:
      return 'Note';
  }
}

function activityDetail(
  a: ActivityView,
  userName: (id: string | null) => string,
): string {
  const by = `by ${userName(a.created_by_id)}`;
  if (a.notes !== null && a.notes.trim() !== '') return `${a.notes} · ${by}`;
  return by;
}

function activityTone(a: ActivityView): CellTone {
  switch (a.type) {
    case 'pipeline_status_change':
      return 'ok';
    case 'call':
    case 'email_logged':
      return 'mute';
    default:
      return 'mute';
  }
}

function labelCategory(c: NonNullable<ActivityView['category']>): string {
  switch (c) {
    case 'CLIENT_INTERACTION':
      return 'Client interaction';
    case 'HIRING_TEAM':
      return 'Hiring team';
    case 'COMMERCIAL':
      return 'Commercial';
    case 'INTERVIEW_FEEDBACK':
      return 'Interview feedback';
    case 'DECISION':
      return 'Decision';
    case 'RISK_BLOCKER':
      return 'Risk / blocker';
    default:
      return 'Note';
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function formatDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleDateString();
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function daysOpen(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
