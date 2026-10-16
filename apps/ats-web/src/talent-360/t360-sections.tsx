import { Dialog, Select, TextArea } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import { createNote, listActivities } from '../activity/activity-api';
import { formatActivityNote } from '../activity/activity-note-format';
import type { ActivityView } from '../activity/types';
import { ConsentHistoryPanel } from '../consent/ConsentHistoryPanel';
import {
  talentRequisition360Path,
  type Tr360NavState,
} from '../requisitions/talent-requisition-360/route';
import { getDossier, type DossierHead } from '../talent/dossier-api';
import { EditResumePanel } from '../talent/TalentEditView';
import { updateErrorMessage } from '../talent/error-messages';
import { buildPatchBody, stateFromTalent, type IntakeState } from '../talent/intake-fields';
import {
  AVAILABILITY_LABELS,
  ENGAGEMENT_LABELS,
  WORK_AUTHORIZATION_LABELS,
  WORK_AUTHORIZATION_VALUES,
  withCurrency,
} from '../talent/stated-fields';
import { updateTalent } from '../talent/talent-api';
import { listTalentMemberships, type SavedListVisibility } from '../talent/saved-list-api';
import type { TalentRecordView, WorkAuthorizationStateView } from '../talent/types';
import { Button } from '../ui';
import { bandLabel } from '../ui/band-map';
import { resolveUserNames } from '../users/users-api';

import {
  ACTIVITY_FILTERS,
  ICON,
  STAGES,
  activityIcon,
  attentionDot,
  clockTime,
  dueLabel,
  labelize,
  monthYear,
  oppSubTone,
  orderFacts,
  relativeDay,
  shortDate,
  stageIndex,
  stagePill,
  workAuthLabel,
  type T360Section,
} from './t360-model';
import { DocumentPreviewDialog, EmailPreviewDialog } from './t360-previews';
import { channelLabel, dispositionReasonLabel, engagementLabel } from './t360-vocab';
import type {
  ActiveOpportunityView,
  AttentionItemView,
  RecentActivityItemView,
  Talent360View as Model,
  TalentDocumentView,
} from './talent-360-types';

// Talent 360 (redesign) — one view per section (§6–§9). Presentation over the
// composed read; every action reuses an existing governed flow (§10).

const TR360_STATE: Tr360NavState = { tr360From: 'talent-360' };

export function Glyph({ d, size = 14, width = 1.8 }: { d: string; size?: number; width?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }): JSX.Element {
  return (
    <Button unstyled type="button" className="t360-arrow" onClick={onClick}>
      {children}
    </Button>
  );
}

function ReqTag({ label }: { label: string }): JSX.Element {
  return <span className="t360-reqtag">{label}</span>;
}

// ── shared rows ───────────────────────────────────────────────────────────────

function ActivityRow({ a, full }: { a: RecentActivityItemView; full: boolean }): JSX.Element {
  const { talentId = '' } = useParams();
  const [previewOpen, setPreviewOpen] = useState(false);
  const canPreview = a.preview_id !== null && talentId !== '';
  return (
    <div className={`t360-act${full ? ' t360-act--full' : ''}`}>
      <span className="t360-act__time">
        <b>{relativeDay(a.occurred_at)}</b>
        {clockTime(a.occurred_at)}
      </span>
      <span className={`t360-act__icon t360-cat--${a.category}`}>
        <Glyph d={activityIcon(a.category, a.channel)} />
      </span>
      <span className="t360-min0">
        <span className="t360-act__head">
          {canPreview ? (
            <Button
              unstyled
              type="button"
              className="t360-act__title-link"
              onClick={() => setPreviewOpen(true)}
              aria-label={`Preview ${a.title.toLowerCase()}${a.requisition_label !== null ? ` · ${a.requisition_label}` : ''}`}
            >
              {a.title}
            </Button>
          ) : (
            <b>{a.title}</b>
          )}
          {a.requisition_label !== null ? <ReqTag label={a.requisition_label} /> : null}
        </span>
        {a.body !== null ? <span className="t360-act__text">{formatActivityNote(a.body)}</span> : null}
        {full && a.actor_label !== null ? <span className="t360-act__who">{a.actor_label}</span> : null}
      </span>
      {previewOpen && a.preview_id !== null ? (
        <EmailPreviewDialog talentId={talentId} interactionId={a.preview_id} onClose={() => setPreviewOpen(false)} />
      ) : null}
    </div>
  );
}

// Key-fact values arrive as stored: closed vocabularies map through their
// canonical label maps; compensation defaults its currency to $; free text
// ("Vienna, VA") is shown exactly as stated.
const FACT_LABEL_MAPS: Record<string, Readonly<Record<string, string>>> = {
  availability: AVAILABILITY_LABELS,
  engagement: ENGAGEMENT_LABELS,
  'work authorization': WORK_AUTHORIZATION_LABELS,
};
function factValue(label: string, value: string): string {
  const key = label.replace(/_/g, ' ').toLowerCase();
  if (key === 'compensation') return withCurrency(value);
  const map = FACT_LABEL_MAPS[key];
  if (map !== undefined) return map[value] ?? map[value.toLowerCase()] ?? map[value.toUpperCase()] ?? value;
  return value;
}

function FactGrid({ facts, min }: { facts: readonly { label: string; value: string; source: string | null }[]; min: 170 | 190 }): JSX.Element {
  return (
    <div className={`t360-facts t360-facts--${min}`}>
      {orderFacts(facts).map((f) => (
        <div key={f.label} className="t360-fact">
          <div className="t360-fact__l">{f.label.replace(/_/g, ' ').toUpperCase()}</div>
          <div className="t360-fact__v">{factValue(f.label, f.value)}</div>
          {f.source !== null ? <div className="t360-fact__s">{f.source}</div> : null}
        </div>
      ))}
    </div>
  );
}

function Skills({ skills }: { skills: Model['profile']['skills'] }): JSX.Element {
  return (
    <div className="t360-skills">
      {skills.map((s) => (
        <span
          key={s.label}
          className={`t360-skill${s.verified ? ' t360-skill--ok' : ''}`}
          title={s.verified ? 'Backed by resume + second source' : 'Self-reported'}
        >
          {s.label}
        </span>
      ))}
    </div>
  );
}

function OppIdentity({ o }: { o: ActiveOpportunityView }): JSX.Element {
  return (
    <>
      <span className="t360-opp__idline">
        <span className="t360-mono">{o.requisition_code}</span>
        <b>{o.client_name ?? 'Client'}</b>
      </span>
      {o.role_title !== null ? <span className="t360-opp__role">{o.role_title}</span> : null}
    </>
  );
}

function OppState({ o, attention, withBar }: { o: ActiveOpportunityView; attention: readonly AttentionItemView[] | null; withBar: boolean }): JSX.Element {
  const pill = stagePill(o.stage);
  const idx = stageIndex(o.stage);
  const sub = [idx >= 0 ? `Stage ${idx + 1} of 8` : null, o.age_label !== null ? `${o.age_label} in stage` : null]
    .filter((x): x is string => x !== null)
    .join(' · ');
  return (
    <>
      <span className="t360-opp__state">
        <span className={`t360-pill t360-tone--${pill.tone}`}>{pill.label}</span>
        {o.contextual_state !== null ? <span className="t360-opp__ctx">{o.contextual_state}</span> : null}
      </span>
      {withBar ? (
        <span className="t360-bar" aria-hidden="true">
          {STAGES.map((s, i) => (
            <span key={s} title={s} className={`t360-bar__seg${i < idx ? ' t360-bar__seg--done' : i === idx ? ' t360-bar__seg--cur' : ''}`} />
          ))}
        </span>
      ) : null}
      {sub !== '' ? <span className={`t360-opp__sub t360-opp__sub--${oppSubTone(o.requisition_id, attention)}`}>{sub}</span> : null}
    </>
  );
}

// ── Overview (§6) ─────────────────────────────────────────────────────────────

export interface OverviewProps {
  readonly model: Model;
  readonly talentId: string;
  readonly firstName: string;
  readonly go: (s: T360Section) => void;
  readonly onAttention: (a: AttentionItemView) => void;
  readonly tasks: ReactNode;
}

export function OverviewSection({ model, talentId, firstName, go, onAttention, tasks }: OverviewProps): JSX.Element {
  const active = model.opportunities?.active ?? [];
  const attention = model.attention;
  const recent = (model.recent_activity?.items ?? []).slice(0, 5);
  const r = model.relationship;
  return (
    <div className="t360-grid">
      <div className="t360-col t360-col--wide">
        {model.opportunities !== null ? (
          <div className="t360-card t360-card--clip" data-testid="t360-active-opps">
            <div className="t360-opps__hd">
              <span className="t360-card__title">Active opportunities</span>
              <span className="t360-count t360-tone--blue">{active.length}</span>
              <span className="t360-hint">Each opens its Talent × Requisition 360</span>
              <LinkButton onClick={() => go('opps')}>All opportunities →</LinkButton>
            </div>
            {active.map((o) => (
              <Link
                key={o.pipeline_id}
                to={talentRequisition360Path(o.requisition_id, talentId)}
                state={TR360_STATE}
                className="t360-orow"
              >
                <span className="t360-min0">
                  <OppIdentity o={o} />
                </span>
                <span className="t360-min0">
                  <OppState o={o} attention={attention} withBar={false} />
                </span>
                <span className="t360-owner">{o.owner_label ?? ''}</span>
                <span className="t360-chev">
                  <Glyph d={ICON.chevron} width={2} />
                </span>
              </Link>
            ))}
            {active.length === 0 ? <div className="t360-empty t360-empty--pad">No active opportunities.</div> : null}
          </div>
        ) : null}

        <div className="t360-card t360-card--pad">
          <div className="t360-card__hd">
            <span className="t360-card__title">Key facts</span>
            <LinkButton onClick={() => go('profile')}>Full profile →</LinkButton>
          </div>
          {model.profile.facts.length > 0 ? <FactGrid facts={model.profile.facts} min={170} /> : <div className="t360-empty">No key facts on record yet.</div>}
          {model.profile.skills.length > 0 ? <Skills skills={model.profile.skills} /> : null}
        </div>

        {model.recent_activity !== null ? (
          <div className="t360-card t360-card--act">
            <div className="t360-card__hd t360-card__hd--tight">
              <span className="t360-card__title">Recent activity</span>
              <LinkButton onClick={() => go('activity')}>All activity →</LinkButton>
            </div>
            {recent.map((a) => (
              <ActivityRow key={a.id} a={a} full={false} />
            ))}
            {recent.length === 0 ? <div className="t360-empty">No activity yet.</div> : null}
          </div>
        ) : null}
      </div>

      <div className="t360-col">
        {attention !== null && model.authorized_sections.attention ? (
          <div className="t360-card t360-card--side" data-testid="t360-attention">
            <div className="t360-side__hd">
              <span className="t360-card__title">Your attention</span>
              {attention.length > 0 ? <span className="t360-count t360-count--sm t360-tone--amber">{attention.length}</span> : null}
            </div>
            <div className="t360-caption">Same facts as My Desk, scoped to {firstName} · clears when resolved</div>
            {attention.length === 0 ? (
              <div className="t360-calm">Nothing needs your attention right now.</div>
            ) : (
              attention.map((a) => (
                <div key={a.id} className="t360-attn">
                  <span className={`t360-dot t360-dot--${attentionDot(a.kind)}`} />
                  <span className="t360-min0 t360-grow">
                    <span className="t360-attn__t">{a.title}</span>
                    <span className="t360-attn__s">{a.subtitle ?? a.requisition_label ?? ''}</span>
                  </span>
                  {a.action !== null ? (
                    <Button unstyled type="button" className="t360-btn t360-btn--mini" onClick={() => onAttention(a)}>
                      {a.action.label}
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
        {tasks}
        <div className="t360-card t360-card--side">
          <div className="t360-card__title t360-mb6">Relationship</div>
          <div className="t360-rel">
            {r.history.known_since !== null ? `Known since ${monthYear(r.history.known_since)} · ` : ''}
            <b>{r.history.requisitions} requisitions</b> · {r.history.submittals} submittals · {r.history.interviews} interviews ·{' '}
            {r.history.placements === 0 ? 'no placements yet' : `${r.history.placements} placements`}
          </div>
          <div className="t360-relrows">
            {r.ownership.also_working_with.length > 0 ? (
              <span className="t360-relrow">
                <span>Currently working with</span>
                <span className="t360-relrow__v">
                  {r.ownership.also_working_with.map((w) => (
                    <span key={`${w.user_id}-${w.requisition_id ?? ''}`} className="t360-block">
                      <b>{w.name ?? '—'}</b>
                      {w.requisition_label !== null ? ` · ${w.requisition_label}` : ''}
                    </span>
                  ))}
                </span>
              </span>
            ) : null}
            {r.ownership.worked_with_before.length > 0 ? (
              <span className="t360-relrow">
                <span>Worked with before</span>
                <span>
                  {r.ownership.worked_with_before
                    .map((w) => `${w.name ?? '—'}${w.requisition_label !== null ? ` · ${w.requisition_label}` : ''}`)
                    .join(', ')}
                </span>
              </span>
            ) : null}
            {r.ownership.owner_provenance !== null ? (
              <span className="t360-relrow">
                <span>Record added by</span>
                <span>
                  {r.ownership.owner_provenance.name ?? '—'}
                  {r.ownership.source !== null ? ` · ${r.ownership.source}` : ''}
                </span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tasks (card on Overview + section) ────────────────────────────────────────

export interface TasksProps {
  readonly tasks: Model['tasks'];
  readonly canTaskWrite: boolean;
  readonly canFollowUp: boolean;
  readonly busyId: string | null;
  readonly onComplete: (id: string) => void;
  readonly onFollowUp: () => void;
  readonly onAll?: () => void;
}

function TaskRows({ tasks, canTaskWrite, busyId, onComplete, full }: Omit<TasksProps, 'canFollowUp' | 'onFollowUp' | 'onAll'> & { full: boolean }): JSX.Element {
  const list = tasks ?? [];
  if (list.length === 0) return <div className="t360-empty">No open tasks.</div>;
  return (
    <div className={full ? '' : 't360-mt6'}>
      {list.map((t) => {
        const done = t.status === 'done' || t.status === 'cancelled';
        const due = t.due_date !== null ? dueLabel(t.due_date) : null;
        return (
          <div key={t.id} className={`t360-task${full ? ' t360-task--full' : ''}`}>
            {canTaskWrite ? (
              done ? (
                <span className="t360-check t360-check--done" aria-hidden="true">
                  ✓
                </span>
              ) : (
                <Button unstyled type="button" className="t360-check" title="Mark done" aria-label={`Complete: ${t.title}`} disabled={busyId === t.id} onClick={() => onComplete(t.id)} />
              )
            ) : (
              <span className="t360-taskdot" aria-hidden="true" />
            )}
            <span className="t360-min0 t360-grow">
              <span className={`t360-task__t${done ? ' t360-task__t--done' : ''}`}>{t.title}</span>
              <span className="t360-task__m">
                <b className={due?.soon === true ? 't360-due--soon' : ''}>{due?.text ?? 'No due date'}</b> · {t.requisition_label ?? 'No requisition'}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function TasksCard(p: TasksProps): JSX.Element | null {
  if (p.tasks === null) return null;
  return (
    <div className="t360-card t360-card--side">
      <div className="t360-card__hd t360-card__hd--flat">
        <span className="t360-card__title">Tasks</span>
        {p.onAll !== undefined ? <LinkButton onClick={p.onAll}>All tasks →</LinkButton> : null}
      </div>
      <TaskRows tasks={p.tasks} canTaskWrite={p.canTaskWrite} busyId={p.busyId} onComplete={p.onComplete} full={false} />
    </div>
  );
}

export function TasksSection(p: TasksProps): JSX.Element {
  return (
    <div className="t360-card t360-card--sect t360-narrow">
      <div className="t360-card__hd t360-card__hd--tight">
        <span className="t360-sect__title">Tasks</span>
        {p.canFollowUp ? (
          <Button unstyled type="button" className="t360-btn t360-btn--brandline t360-btn--sm t360-ml-auto" onClick={p.onFollowUp}>
            + Follow up
          </Button>
        ) : null}
      </div>
      <div className="t360-caption t360-caption--sect">
        Created deliberately by people. Done when checked off. Business-state items live in Your attention.
      </div>
      {p.tasks === null ? (
        <div className="t360-empty">You don’t have access to tasks.</div>
      ) : (
        <TaskRows tasks={p.tasks} canTaskWrite={p.canTaskWrite} busyId={p.busyId} onComplete={p.onComplete} full />
      )}
    </div>
  );
}

// ── Opportunities (§7) ────────────────────────────────────────────────────────

export function OpportunitiesSection({
  model,
  talentId,
  canAddToRequisition,
  onAddToRequisition,
}: {
  model: Model;
  talentId: string;
  canAddToRequisition: boolean;
  onAddToRequisition: () => void;
}): JSX.Element {
  if (model.opportunities === null) return <NoAccess title="Opportunities" />;
  const { active, closed } = model.opportunities;
  return (
    <div className="t360-card t360-card--clip" data-testid="t360-opps">
      <div className="t360-opps__sect">
        <span className="t360-sect__title">Opportunities</span>
        <span className="t360-caption t360-caption--inline">One row per requisition. Open one to work it in Talent × Requisition 360.</span>
        {canAddToRequisition ? (
          <Button unstyled type="button" className="t360-btn t360-btn--neutral t360-btn--sm t360-ml-auto" onClick={onAddToRequisition}>
            + Add to requisition
          </Button>
        ) : null}
      </div>
      <div className="t360-groupbar">ACTIVE · {active.length}</div>
      {active.map((o) => {
        const path = talentRequisition360Path(o.requisition_id, talentId);
        return (
          <div key={o.pipeline_id} className="t360-arow">
            <span className="t360-arow__id">
              <OppIdentity o={o} />
            </span>
            <span className="t360-arow__state">
              <OppState o={o} attention={model.attention} withBar />
            </span>
            <span className="t360-arow__end">
              <span className="t360-owner">{o.owner_label ?? ''}</span>
              {o.next_action !== null ? (
                // The owning domain's next action — performed on that opportunity's page.
                <Link
                  to={o.next_action.href ?? path}
                  state={o.next_action.href === null ? TR360_STATE : undefined}
                  className="t360-btn t360-btn--secondary t360-btn--sm"
                >
                  {o.next_action.label}
                </Link>
              ) : null}
              <Link to={path} state={TR360_STATE} className="t360-btn t360-btn--neutral t360-btn--sm">
                Open full view ↗
              </Link>
            </span>
          </div>
        );
      })}
      {active.length === 0 ? <div className="t360-empty t360-empty--pad">No active opportunities.</div> : null}
      <div className="t360-groupbar">PAST · {closed.length}</div>
      {closed.map((c) => (
        <div key={c.pipeline_id} className="t360-prow">
          <span className="t360-mono t360-prow__req">{c.requisition_code}</span>
          <span className="t360-prow__main">
            <b>{c.role_title ?? 'Requisition'}</b>
            <span className="t360-muted"> · {c.client_name ?? 'Client'}</span>
            <span className="t360-prow__detail">{c.reason !== null ? dispositionReasonLabel(c.reason) : 'Reason not recorded'}</span>
          </span>
          <span className={`t360-pill ${/withdr/i.test(c.outcome) ? 't360-tone--amber' : 't360-tone--greyalt'}`}>{c.outcome}</span>
          <span className="t360-prow__when">{c.closed_at !== null ? monthYear(c.closed_at) : ''}</span>
        </div>
      ))}
    </div>
  );
}

// ── Work authorization (§8) ───────────────────────────────────────────────────

export interface WorkAuthSectionProps {
  readonly model: Model;
  readonly firstName: string;
  /** talent:edit and the full record is readable → inline edit (§8A.7 pattern). */
  readonly editable: boolean;
  readonly record: TalentRecordView | null;
  readonly go: (s: T360Section) => void;
  readonly workAuth: WorkAuthorizationStateView | null;
  readonly onRecordSaved: (rec: TalentRecordView) => void;
  readonly notify: (msg: string) => void;
}

export function WorkAuthSection({ model, firstName, editable, record, go, workAuth, onRecordSaved, notify }: WorkAuthSectionProps): JSX.Element {
  const h = model.header;
  const wa = workAuth?.current ?? null;
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = record !== null ? record.work_authorization : h.work_authorization;

  const save = async (): Promise<void> => {
    if (record === null) return;
    // Edit talent's own body builder: only the changed field ('' clears to null).
    const body = buildPatchBody({ ...stateFromTalent(record), work_authorization: status as IntakeState['work_authorization'] }, record) as unknown as Record<string, unknown>;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      notify('Work authorization saved · no changes');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      onRecordSaved(await updateTalent(record.id, body));
      setEditing(false);
      notify('Work authorization saved · 1 field updated');
    } catch (e) {
      setErr(updateErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const cells: { l: string; v: ReactNode; s: string }[] = [
    {
      l: 'STATUS',
      v: editing ? (
        <Select unstyled className="t360-ctl" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Not stated</option>
          {WORK_AUTHORIZATION_VALUES.map((v) => (
            <option key={v} value={v}>
              {WORK_AUTHORIZATION_LABELS[v]}
            </option>
          ))}
        </Select>
      ) : current !== null ? (
        workAuthLabel(current)
      ) : (
        'Not on record'
      ),
      s: wa !== null ? `Declared · ${shortDate(wa.asserted_at)}${wa.visa_type !== null && wa.visa_type !== '' ? ` · ${wa.visa_type}` : ''}` : 'Declared',
    },
    { l: 'DOCUMENT', v: '—', s: 'Collected at pre-start, not before' },
    // TI-1G: requires_sponsorship is not collected by any surface yet (default only).
    { l: 'SPONSORSHIP', v: '—', s: wa !== null && wa.expires_at !== null ? `Not collected yet · authorization expires ${shortDate(wa.expires_at)}` : 'Not collected yet' },
    { l: 'ENGAGEMENT TYPES', v: h.engagement_type !== null ? engagementLabel(h.engagement_type) : '—', s: 'Talent-stated' },
  ];
  return (
    <div className={`t360-card t360-card--prof t360-narrow${editing ? ' t360-pblock--editing' : ''}`} data-testid="t360-auth">
      <div className="t360-sect__title t360-mb4">Work authorization</div>
      <div className="t360-lede">What {firstName} has told us, and what&apos;s on file. Requisition-specific checks stay on each opportunity.</div>
      {err !== null ? (
        <div className="t360-ferr t360-ferr--card" role="alert">
          {err}
        </div>
      ) : null}
      <div className="t360-facts t360-facts--180">
        {cells.map((c) => (
          <div key={c.l} className="t360-fact t360-fact--roomy">
            <div className="t360-fact__l">{c.l}</div>
            <div className="t360-fact__v">{c.v}</div>
            <div className="t360-fact__s">{c.s}</div>
          </div>
        ))}
      </div>
      <div className="t360-row8">
        {editing ? (
          <>
            <Button unstyled type="button" className="t360-btn t360-btn--primary t360-btn--sm" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button unstyled type="button" className="t360-btn t360-btn--neutral t360-btn--sm" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : editable ? (
          <Button
            unstyled
            type="button"
            className="t360-btn t360-btn--neutral t360-btn--sm"
            onClick={() => {
              setStatus(record?.work_authorization ?? '');
              setErr(null);
              setEditing(true);
            }}
          >
            Update
          </Button>
        ) : null}
        <LinkButton onClick={() => go('trust')}>See evidence in Talent Trust →</LinkButton>
      </div>
    </div>
  );
}

// ── Activity (§7) ─────────────────────────────────────────────────────────────

export function ActivitySection({ model }: { model: Model }): JSX.Element {
  const [filter, setFilter] = useState('all');
  if (model.recent_activity === null) return <NoAccess title="Activity" />;
  const { items, category_counts } = model.recent_activity;
  const shown = filter === 'all' ? items : items.filter((i) => i.category === filter);
  return (
    <div className="t360-card t360-card--sect" data-testid="t360-activity">
      <div className="t360-card__hd t360-card__hd--filters">
        <span className="t360-sect__title">Activity</span>
        <span className="t360-filters">
          {ACTIVITY_FILTERS.map((f) => {
            const on = filter === f.key;
            return (
              <Button unstyled key={f.key} type="button" className={`t360-filter${on ? ' t360-filter--on' : ''}`} aria-pressed={on} onClick={() => setFilter(f.key)}>
                {f.label} <span className="t360-filter__n">{f.key === 'all' ? items.length : (category_counts[f.key] ?? 0)}</span>
              </Button>
            );
          })}
        </span>
      </div>
      {shown.map((a) => (
        <ActivityRow key={a.id} a={a} full />
      ))}
      {shown.length === 0 ? <div className="t360-empty">No activity of this type yet.</div> : null}
    </div>
  );
}

// ── Lists (§7) ────────────────────────────────────────────────────────────────

export function ListsSection({ talentId, firstName, canAddToList, onAddToList, reloadToken }: { talentId: string; firstName: string; canAddToList: boolean; onAddToList: () => void; reloadToken: number }): JSX.Element {
  const [lists, setLists] = useState<readonly { id: string; name: string; visibility: SavedListVisibility }[] | null>(null);
  useEffect(() => {
    let live = true;
    listTalentMemberships([talentId])
      .then((rows) => {
        if (live) setLists(rows[0]?.lists ?? []);
      })
      .catch(() => {
        if (live) setLists([]);
      });
    return () => {
      live = false;
    };
  }, [talentId, reloadToken]);
  return (
    <div className="t360-card t360-card--sect t360-narrow">
      <div className="t360-card__hd t360-card__hd--tight">
        <span className="t360-sect__title">Lists</span>
        {canAddToList ? (
          <Button unstyled type="button" className="t360-btn t360-btn--neutral t360-btn--sm t360-ml-auto" onClick={onAddToList}>
            + Add to list
          </Button>
        ) : null}
      </div>
      <div className="t360-caption t360-caption--sect">Where {firstName} has been grouped to come back to.</div>
      {lists === null ? <div className="t360-empty">Loading…</div> : null}
      {lists !== null && lists.length === 0 ? <div className="t360-empty">Not on any list yet.</div> : null}
      {(lists ?? []).map((l) => (
        <div key={l.id} className="t360-list">
          {/* No saved-list deep link exists in ats-web — the name is not a link (data gap). */}
          <span className="t360-list__name">{l.name}</span>
          <span className="t360-pill t360-pill--sm t360-tone--grey">{l.visibility === 'tenant' ? 'Tenant' : 'Private'}</span>
        </div>
      ))}
    </div>
  );
}

// ── Notes (§7) ────────────────────────────────────────────────────────────────

export function NotesSection({ talentId, firstName, canWrite }: { talentId: string; firstName: string; canWrite: boolean }): JSX.Element {
  const [notes, setNotes] = useState<readonly ActivityView[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    listActivities('talent_record', talentId)
      .then((r) => {
        const list = r.items.filter((a) => a.type === 'note' && a.redacted_at === null).sort((a, b) => b.created_at.localeCompare(a.created_at));
        setNotes(list);
        const ids = [...new Set(list.map((n) => n.created_by_id).filter((x): x is string => x !== null))];
        if (ids.length > 0) {
          void resolveUserNames(ids)
            .then(setNames)
            .catch(() => undefined);
        }
      })
      .catch(() => setNotes([]));
  }, [talentId]);
  useEffect(() => load(), [load]);
  const save = (): void => {
    const text = draft.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setErr(null);
    createNote({ type: 'note', subject_type: 'talent_record', subject_id: talentId, notes: text })
      .then(() => {
        setDraft('');
        load();
      })
      .catch(() => setErr('Couldn’t add the note. Please try again.'))
      .finally(() => setBusy(false));
  };
  const empty = draft.trim() === '';
  return (
    <div className="t360-card t360-card--sect t360-narrow">
      <div className="t360-sect__title t360-mb8">Notes</div>
      {canWrite ? (
        <>
          <TextArea
            unstyled
            className="t360-notearea"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Add a note about ${firstName} (not tied to a requisition)…`}
            aria-label="Note"
          />
          <div className="t360-noteact">
            {err !== null ? <span className="t360-err">{err}</span> : null}
            <Button unstyled type="button" className={`t360-btn t360-btn--primary t360-btn--note${empty ? ' t360-btn--inert' : ''}`} aria-disabled={empty || busy} onClick={save}>
              Add note
            </Button>
          </div>
        </>
      ) : null}
      {notes === null ? <div className="t360-empty">Loading…</div> : null}
      {notes !== null && notes.length === 0 ? <div className="t360-empty">No notes yet.</div> : null}
      {(notes ?? []).map((n) => (
        <div key={n.id} className="t360-noterow">
          <div className="t360-noterow__t">{n.notes}</div>
          <div className="t360-noterow__m">
            {(n.created_by_id !== null ? names[n.created_by_id] : undefined) ?? 'Someone'} · {shortDate(n.created_at)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Talent Trust (§9) ─────────────────────────────────────────────────────────

interface TrustClaim {
  readonly claim: string;
  readonly evidence: string;
  readonly state: string;
  readonly tone: 'green' | 'amber' | 'greyalt';
  readonly action?: { readonly label: string; readonly run: () => void };
}

function bandTone(band: string): TrustClaim['tone'] {
  if (/support|verif|strong|valid|confirm|resolv/i.test(band)) return 'green';
  if (/review|pend|thin|weak|await|expir/i.test(band)) return 'amber';
  return 'greyalt';
}

export function TrustSection({
  model,
  talentId,
  canResolveIdentity,
  onDismissDuplicate,
  onRecordConsent,
}: {
  model: Model;
  talentId: string;
  canResolveIdentity: boolean;
  onDismissDuplicate: (advisoryId: string) => void;
  onRecordConsent: () => void;
}): JSX.Element {
  const [head, setHead] = useState<DossierHead | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    let live = true;
    getDossier(talentId)
      .then((d) => {
        if (live) setHead(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [talentId]);

  const id = model.identity;
  const claims: TrustClaim[] = [];
  if (id !== null) {
    const both = id.primary_email_confirmed && id.mobile_confirmed;
    claims.push({
      claim: 'Identity · email and mobile',
      evidence: both ? 'Email control confirmed · mobile confirmed' : id.primary_email_confirmed ? 'Email confirmed · mobile not yet confirmed' : 'Not yet confirmed',
      state: both ? 'Supported' : 'Review needed',
      tone: both ? 'green' : 'amber',
    });
    const adv = id.advisory;
    claims.push(
      adv !== null
        ? {
            claim: 'Duplicate check',
            evidence: adv.label,
            state: 'Review needed',
            tone: 'amber',
            ...(canResolveIdentity ? { action: { label: 'Not the same person', run: () => onDismissDuplicate(adv.advisory_id) } } : {}),
          }
        : { claim: 'Duplicate check', evidence: 'No unresolved duplicate for this record', state: 'Resolved', tone: 'green' },
    );
  }
  if (model.header.work_authorization !== null) {
    claims.push({
      claim: `Work authorization · ${workAuthLabel(model.header.work_authorization)}`,
      evidence: 'Declared on the record · no document on file yet',
      state: 'Claimed',
      tone: 'greyalt',
    });
  }
  if (head !== null && head.ledger_established) {
    const dims: readonly { key: 'claims' | 'continuity' | 'eligibility'; label: string }[] = [
      { key: 'claims', label: 'Claims on record' },
      { key: 'continuity', label: 'Employment continuity' },
      { key: 'eligibility', label: 'Eligibility' },
    ];
    for (const d of dims) {
      const band = head.dimensions?.[d.key]?.band;
      if (band !== undefined && band !== null) {
        claims.push({ claim: d.label, evidence: 'From the evidence ledger', state: bandLabel(String(band)), tone: bandTone(String(band)) });
      }
    }
  }

  const c = model.header.contactability;
  const lc = model.relationship_strip.last_contact;
  const yn = (b: boolean): JSX.Element => <b className={b ? 't360-ok' : 't360-no'}>{b ? 'Permitted' : 'Not permitted'}</b>;
  return (
    <div className="t360-grid" data-testid="t360-trust">
      <div className="t360-card t360-card--sect t360-col--wide">
        <div className="t360-sect__title">Talent Trust</div>
        <div className="t360-caption t360-caption--trust">Each claim shows what supports it. No scores.</div>
        {claims.length === 0 ? <div className="t360-empty">No trust evidence recorded for this record yet.</div> : null}
        {claims.map((t) => (
          <div key={t.claim} className="t360-claim">
            <span className="t360-claim__main">
              <b>{t.claim}</b>
              <span>{t.evidence}</span>
            </span>
            <span className={`t360-pill t360-tone--${t.tone}`}>{t.state}</span>
            {t.action !== undefined ? (
              <Button unstyled type="button" className="t360-btn t360-btn--mini" onClick={t.action.run}>
                {t.action.label}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="t360-card t360-card--side">
        <div className="t360-card__title t360-mb9">Contactability</div>
        <div className="t360-contact">
          <span>
            <span>Recruiting contact</span>
            {yn(c.recruiting_permitted)}
          </span>
          <span>
            <span>Email</span>
            {yn(c.email_permitted)}
          </span>
          <span>
            <span>Phone &amp; voice</span>
            {yn(c.phone_permitted)}
          </span>
          <span>
            <span>SMS</span>
            {yn(c.sms_permitted)}
          </span>
          {lc !== null ? (
            <span className="t360-contact__div">
              <span>Last contact</span>
              <span className="t360-ink">
                {relativeDay(lc.at)} {clockTime(lc.at)} · {channelLabel(lc.channel)}
              </span>
            </span>
          ) : null}
          {!c.recruiting_permitted ? (
            <Button unstyled type="button" className="t360-btn t360-btn--brandline t360-btn--sm" onClick={onRecordConsent}>
              Record consent
            </Button>
          ) : null}
          <LinkButton onClick={() => setHistoryOpen(true)}>Consent history →</LinkButton>
        </div>
      </div>
      {historyOpen ? (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setHistoryOpen(false);
          }}
          title="Consent history"
        >
          <ConsentHistoryPanel talentId={talentId} />
        </Dialog>
      ) : null}
    </div>
  );
}

// ── Conversation Intelligence + Technical Screening (§9) ──────────────────────
// No ats-web read exists for either (CI transcripts; INC-3 screening is not on
// main): the specified empty states render, nothing is fabricated.

export function CiSection(): JSX.Element {
  return (
    <div className="t360-card t360-card--sect" data-testid="t360-ci">
      <div className="t360-sect__title">Conversation Intelligence</div>
      <div className="t360-caption t360-caption--trust">
        Consented recordings only. Each conversation stays attached to the requisition it was captured for — open it there to work with it.
      </div>
      <div className="t360-empty t360-empty--rowtop">No recorded conversations yet.</div>
    </div>
  );
}

export function ScreeningSection({ talentId, canScreen }: { talentId: string; canScreen: boolean }): JSX.Element {
  return (
    <div className="t360-card t360-card--sect" data-testid="t360-ts">
      <div className="t360-sect__title">Technical Screening</div>
      <div className="t360-caption t360-caption--trust">
        History across requisitions. Screenings are prepared and run per requisition, in Talent × Requisition 360.
      </div>
      {canScreen ? (
        <div className="t360-empty t360-empty--rowtop">
          <Link className="t360-arrow" to={`/talent/${talentId}/screening`}>
            Open technical screening →
          </Link>
        </div>
      ) : (
        <div className="t360-empty t360-empty--rowtop">No technical screenings yet.</div>
      )}
      <div className="t360-tsfoot">Findings are recruiter-attested. Aramo never qualifies, rejects or ranks.</div>
    </div>
  );
}

function NoAccess({ title }: { title: string }): JSX.Element {
  return (
    <div className="t360-card t360-card--sect">
      <div className="t360-sect__title">{title}</div>
      <div className="t360-empty">You don’t have access to this section.</div>
    </div>
  );
}
