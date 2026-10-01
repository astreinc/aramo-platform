import { Button } from '@aramo/fe-foundation';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { ActivityView } from '../activity/types';
import { LogNoteDialog } from '../activity/LogNoteDialog';
import type { InterviewCalendarRow } from '../interviews/interviews-api';
import type { TaskView } from '../task/types';
import { TASK_ACTIVE_STATUS_VALUES } from '../task/types';
import { Icons } from '../ui';

import { AddTalentDialog } from './AddTalentDialog';
import {
  BOARD_COLUMN_LABELS,
  blockerLabel,
  type BoardCardView,
  type RequisitionTalentBoardView,
} from './requisition-talent-board-api';
import { RECRUITING_STATUS_LABELS, type RequisitionView } from './types';
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
// Layout — two columns (prototype parity): MAIN = Needs attention / Pipeline /
// Talent in play; RAIL = Requisition context / Upcoming & tasks / Recent
// activity.

interface WorkspacePanelProps {
  readonly req: RequisitionView;
  readonly companyName: string | null;
  readonly contactName: string | null;
  // Recruiter display name, resolved from req.recruiter_id via the directory.
  // Account manager is DELIBERATELY omitted — there is no modeled source for it
  // (owner_id semantics are disavowed and the assignment model is role-less), so
  // the only modeled ownership role shown here is Recruiter.
  readonly recruiterName: string | null;
  readonly locationLabel: string;
  readonly arrangementLabel: string | null;
  readonly board: RequisitionTalentBoardView | null;
  readonly talentNames: Record<string, string>;
  readonly interviews: readonly InterviewCalendarRow[];
  readonly tasks: readonly TaskView[];
  readonly canReadTasks: boolean;
  readonly activities: readonly ActivityView[];
  readonly attentionItems: readonly AttentionItem[];
  readonly scopes: readonly string[];
  readonly existingTalentIds: readonly string[];
  readonly canAddTalent: boolean;
  readonly canSource: boolean;
  readonly canLogNote: boolean;
  readonly onNavigate: (tab: TabId) => void;
  readonly onRefresh: () => void;
}

// Terminal interview states are not "upcoming"; the calendar window already
// bounds the range, so we only drop the done/aborted ones.
const UPCOMING_INTERVIEW_STATES = new Set(['SCHEDULED', 'RESCHEDULED']);

export function WorkspacePanel({
  req,
  companyName,
  contactName,
  recruiterName,
  locationLabel,
  arrangementLabel,
  board,
  talentNames,
  interviews,
  tasks,
  canReadTasks,
  activities,
  attentionItems,
  scopes,
  existingTalentIds,
  canAddTalent,
  canSource,
  canLogNote,
  onNavigate,
  onRefresh,
}: WorkspacePanelProps) {
  const columns = board?.columns ?? [];
  const cards: readonly BoardCardView[] = columns.flatMap((c) => c.cards);

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
  const attn: AttentionItem[] = [
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

  const upcoming = [...interviews]
    .filter((iv) => UPCOMING_INTERVIEW_STATES.has(iv.state))
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
    .slice(0, 5);

  const openTasks = tasks
    .filter((t) => (TASK_ACTIVE_STATUS_VALUES as readonly string[]).includes(t.status))
    .slice(0, 5);

  const recent = [...activities].slice(0, 5);

  const capacityText =
    req.capacity_balance < 0 ? `${-req.capacity_balance} over` : String(req.capacity_balance);

  const nameOf = (id: string): string => talentNames[id] ?? 'Talent';

  return (
    <div className="rc-work rc-ws">
      {/* ── MAIN column ────────────────────────────────────────────────── */}
      <div className="rc-stack">
        <WsCard title="Needs attention">
          {attn.length === 0 ? (
            <p className="rc-empty">Nothing needs attention right now.</p>
          ) : (
            <div className="rc-ws__body">
              {attn.map((item) => (
                <div key={item.key} className="rc-attn__row">
                  <span
                    className={`rc-attn__dot rc-attn__dot--${item.tone}`}
                    aria-hidden="true"
                  />
                  <span className="rc-attn__body">
                    <b>{item.what}</b>
                    {item.detail !== undefined ? (
                      <span className="rc-attn__detail"> {item.detail}</span>
                    ) : null}
                  </span>
                  {item.age !== undefined ? (
                    <span className="rc-attn__age">{item.age}</span>
                  ) : null}
                  <Button
                    unstyled
                    type="button"
                    className="rc-attn__link"
                    onClick={() => onNavigate(item.target)}
                  >
                    {item.linkLabel}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </WsCard>

        <WsCard title="Pipeline">
          {columns.length === 0 ? (
            <p className="rc-empty">No talent in the pipeline yet.</p>
          ) : (
            <ul className="rc-filelist">
              {columns.map((c) => (
                <li key={c.key} className="rc-filelist__row">
                  <Icons.IconUsers />
                  <span className="rc-filelist__nm">{BOARD_COLUMN_LABELS[c.key]}</span>
                  <span className="rc-filelist__meta">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
        </WsCard>

        <WsCard
          title="Talent in play"
          action={
            canSource ? (
              <Link to="/sourcing" className="rc-card__head-more">
                Find talent
              </Link>
            ) : undefined
          }
        >
          {cards.length === 0 ? (
            <div className="rc-ws__body">
              <p className="rc-empty">No talent in play yet.</p>
              {canSource ? (
                <Link to="/sourcing" className="rc-link-action">
                  Find talent for this requisition →
                </Link>
              ) : null}
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
            <ul className="rc-filelist">
              {cards.map((card) => (
                <TalentInPlayRow
                  key={card.pipeline_id}
                  card={card}
                  name={nameOf(card.talent_record_id)}
                  scopes={scopes}
                  onOpen={() => onNavigate('talent')}
                />
              ))}
            </ul>
          )}
        </WsCard>
      </div>

      {/* ── RIGHT rail ─────────────────────────────────────────────────── */}
      <div className="rc-stack">
        <WsCard title="Requisition context">
          <dl className="rc-deflist rc-ws__body">
            <Def label="Client" value={companyName ?? 'Client'} />
            <Def label="Contact" value={contactName ?? '—'} />
            {/* Account manager omitted — no modeled source (role-less assignment
                model; owner_id semantics disavowed). Recruiter is the only
                modeled ownership role. */}
            <Def label="Recruiter" value={recruiterName ?? 'Not assigned'} />
            <Def label="Status" value={RECRUITING_STATUS_LABELS[req.status]} />
            <Def label="Openings" value={String(req.openings)} />
            <Def label="Available" value={String(req.openings_available)} />
            <Def label="Capacity balance" value={capacityText} />
            {locationLabel !== '' ? <Def label="Location" value={locationLabel} /> : null}
            {arrangementLabel !== null ? (
              <Def label="Work arrangement" value={arrangementLabel} />
            ) : null}
            {req.start_date !== null ? (
              <Def label="Start date" value={formatDate(req.start_date)} />
            ) : null}
            <Def label="Open since" value={`${daysOpen(req.created_at)}d`} />
          </dl>
        </WsCard>

        <WsCard title="Upcoming & tasks">
          <div className="rc-ws__sub">Interviews</div>
          {upcoming.length === 0 ? (
            <p className="rc-empty">None scheduled.</p>
          ) : (
            <ul className="rc-filelist">
              {upcoming.map((iv) => (
                <li key={iv.id} className="rc-filelist__row">
                  <Icons.IconClock />
                  <span className="rc-filelist__nm">{iv.talent_name ?? 'Talent'}</span>
                  <span className="rc-filelist__meta">{formatDate(iv.scheduled_at)}</span>
                </li>
              ))}
            </ul>
          )}
          {canReadTasks ? (
            <>
              <div className="rc-ws__sub">Tasks</div>
              {openTasks.length === 0 ? (
                <p className="rc-empty">No open tasks.</p>
              ) : (
                <ul className="rc-filelist">
                  {openTasks.map((t) => (
                    <li key={t.id} className="rc-filelist__row">
                      <Icons.IconList />
                      <span className="rc-filelist__nm">{t.title}</span>
                      {t.due_date !== null ? (
                        <span className="rc-filelist__meta">{formatDate(t.due_date)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </WsCard>

        <WsCard
          title="Recent activity"
          action={
            <span className="rc-card__head-actions">
              {canLogNote ? (
                <LogNoteDialog
                  requisitionId={req.id}
                  requisitionCode={`REQ-${req.requisition_number}`}
                  requisitionTitle={req.title}
                  onSaved={onRefresh}
                />
              ) : null}
              <Button
                unstyled
                type="button"
                className="rc-card__head-more"
                onClick={() => onNavigate('activity')}
              >
                View all
              </Button>
            </span>
          }
        >
          {recent.length === 0 ? (
            <p className="rc-empty">No activity yet.</p>
          ) : (
            <ul className="rc-filelist">
              {recent.map((a) => (
                <li key={a.id} className="rc-filelist__row">
                  <Icons.IconActivity />
                  <span className="rc-filelist__nm">{activityLine(a)}</span>
                  <span className="rc-filelist__meta">{formatDate(a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </WsCard>
      </div>
    </div>
  );
}

// One Talent-in-play row — name + authoritative stage, then the grounded checks
// (aging / RTR / readiness band + blockers). The single CTA is the FIRST next
// action the actor is authorised for (least-visibility: rendered only when the
// actor holds that action's required_scope); it navigates to the governed Talent
// surface — the domain transition is NEVER reimplemented here.
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
  const checks: string[] = [];
  if (card.days_in_stage !== null) checks.push(`${card.days_in_stage}d in stage`);
  if (card.rtr_state !== null) checks.push(`RTR ${card.rtr_state}`);
  if (card.readiness?.band === 'ready_to_submit') checks.push('Ready to submit');
  else if (card.readiness?.band === 'needs_action') checks.push('Needs action');
  const blockers = card.readiness?.blockers ?? [];

  return (
    <li className="rc-filelist__row rc-ws__row">
      <span className="rc-filelist__nm">
        {name}
        <span className="rc-pill rc-pill--neutral rc-ws__stage">
          {BOARD_COLUMN_LABELS[card.column]}
        </span>
      </span>
      {checks.length > 0 ? (
        <span className="rc-muted-line rc-ws__checks">{checks.join(' · ')}</span>
      ) : null}
      {blockers.length > 0 ? (
        <span className="rc-muted-line rc-ws__checks">
          {blockers.map((b) => blockerLabel(b)).join(' · ')}
        </span>
      ) : null}
      {action !== undefined ? (
        <Button unstyled type="button" className="rc-linkbtn rc-ws__cta" onClick={onOpen}>
          {action.label}
        </Button>
      ) : null}
    </li>
  );
}

function WsCard({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="rc-card">
      <div className="rc-card__head">
        <h2>{title}</h2>
        {action !== undefined ? action : null}
      </div>
      {children}
    </div>
  );
}

function Def({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rc-defrow">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// Human one-liner for an activity row — the note body when present, else a
// neutral label for the system-emitted kinds. (Vocabulary-clean: no banned
// terms; "stage change" for the auto pipeline transition event.)
function activityLine(a: ActivityView): string {
  if (a.notes !== null && a.notes.trim() !== '') return a.notes;
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

function formatDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleDateString();
}

function daysOpen(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
