import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Checkbox,
  InlineAlert,
  Select,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { Tabs, type TabItem, Button } from '@aramo/fe-foundation';

import { listActivities } from '../activity/activity-api';
import type { ActivityView } from '../activity/types';
import { listRequisitions } from '../requisitions/requisitions-api';
import { isClosedStatus, type RequisitionView } from '../requisitions/types';
import { useEntityCrumb } from '../shell/breadcrumb';
import { resolveUserNames } from '../users/users-api';
import { TasksPanel } from '../task/TasksPanel';
import { getTalent } from '../talent/talent-api';
import {
  Avatar,
  Card,
  Icons,
  MetricCard,
  StatusPill,
} from '../ui';
import { CompanyAssignmentsView } from '../assignments/CompanyAssignmentsView';

import { CompanyPoliciesView } from './policies/CompanyPoliciesView';
import {
  getCompany,
  getCompanyPlacements,
  getCompanyTeam,
  getOneCompanyMetrics,
  listContactsForCompany,
  updateCompany,
} from './companies-api';
import {
  contactsErrorMessage,
  detailErrorMessage,
  reqsErrorMessage,
  updateErrorMessage,
} from './error-messages';
import type { CompanyView, ContactView } from './types';
import {
  COMMERCIAL_FIELDS,
  EF,
  EFAbout,
  HQ_FIELDS,
  PROFILE_FIELDS,
  SUPPLIER_FIELDS,
  companyToDraft,
  draftToPatch,
  type OverviewDraft,
  type OverviewField,
} from './company-overview-fields';
import {
  REL_STATUS_TONES,
  REL_TYPE_TONES,
  companyTypes,
  lastContactLabel,
  locationOf,
  primaryStatus,
  relStatusLabel,
  relTypeLabel,
  tierLabel,
  type CompanyMetrics,
  type CompanyPlacement,
  type CompanyTeam,
} from './company-workspace';

// Company DETAIL — the "account hub" rebuilt to Company Detail.dc.html.
// Header (logo + relationship/tier/hot pills + meta + actions) · 5-card KPI strip
// (Open requisitions / Submitted / Active placements / Fill rate / Last activity)
// · tabs Overview / Account team / Contacts / Requisitions / Placements /
// Activity / Tasks (each scope-gated; a tab the actor can't read is hidden).
//
// Edit flips the Overview cards to edit IN PLACE (company-overview-fields: every
// field becomes its matching control at the same position; one Save; Cancel
// discards). Commercial terms are masked-by-absence and gated on
// company:read_commercial. Parent company / MSP-VMS / Vendor number have no
// backend write path — they render as read boxes for parity, never fabricated.
// Activity stays confirmed-but-empty (no company write path — CreateNoteRequest
// excludes 'company'), so there is no "Log note" action here.

interface CompanyDetailViewProps {
  readonly sessionOverride?: Session;
}

function display(value: string | null): string {
  return value === null || value === '' ? '—' : value;
}

function fullContactName(c: ContactView): string {
  const name = `${c.first_name} ${c.last_name}`.trim();
  return name === '' ? '—' : name;
}

function clientSince(c: CompanyView): string | null {
  if (c.created_at === null) return null;
  const d = new Date(c.created_at);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getFullYear());
}

export function CompanyDetailView({ sessionOverride }: CompanyDetailViewProps) {
  const { companyId } = useParams<{ companyId: string }>();
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);

  const [company, setCompany] = useState<CompanyView | null>(null);
  // Company Party/Role (ADR-0032, R6) — Edit flips the Overview cards to edit
  // IN PLACE (every field becomes its matching control at the same position,
  // one Save), mirroring the requisition detail edit affordance. `draft` holds
  // the in-flight edits (string-map); Cancel discards it without mutation.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<OverviewDraft>({});
  // Controlled active tab: the header Edit jumps to Overview (edit is in place
  // there); the Overview "Manage" affordance jumps to the Account team tab.
  const [activeTab, setActiveTab] = useState('overview');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<readonly ContactView[]>([]);
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [activities, setActivities] = useState<readonly ActivityView[]>([]);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [team, setTeam] = useState<CompanyTeam | null>(null);
  const [placements, setPlacements] = useState<readonly CompanyPlacement[]>([]);
  const [metrics, setMetrics] = useState<CompanyMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [reqsError, setReqsError] = useState<string | null>(null);

  useEntityCrumb(company?.name);

  const scopes = session?.scopes ?? [];
  const canReadContacts = scopes.includes('contact:read');
  const canAssign = scopes.includes('company:assign');
  const canReadReqs = scopes.includes('requisition:read');
  const canReadActivity = scopes.includes('activity:read');
  const canReadTasks = scopes.includes('task:read');
  // CSP PA-3 — the Company → Policies tab is a CLIENT-management surface: shown for a
  // CLIENT company to an actor with a policy read scope. Per-domain Configure is gated
  // on each domain's write authority; server authorization remains authoritative.
  const canReadPolicies = scopes.includes('client-submittal-policy:read');
  const canConfigurePolicies = {
    engagement: scopes.includes('engagement:policy:write'),
    'client-submittal': scopes.includes('client-submittal-policy:write'),
    'pre-start': scopes.includes('pre_start_requirement:configure'),
  } as const;

  useEffect(() => {
    if (companyId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCompany(companyId)
      .then(async (co) => {
        if (cancelled) return;
        setCompany(co);
        setLoading(false);
        const [
          contactRes,
          reqRes,
          actRes,
          rosterRes,
          metricsRes,
          teamRes,
          placementsRes,
        ] = await Promise.allSettled([
          canReadContacts
            ? listContactsForCompany(companyId)
            : Promise.reject(new Error('no contact scope')),
          canReadReqs
            ? listRequisitions({ company_id: companyId })
            : Promise.reject(new Error('no req scope')),
          canReadActivity
            ? listActivities('company', companyId)
            : Promise.reject(new Error('no activity scope')),
          resolveUserNames(),
          getOneCompanyMetrics(companyId),
          getCompanyTeam(companyId),
          canReadReqs
            ? getCompanyPlacements(companyId)
            : Promise.reject(new Error('no req scope')),
        ]);
        if (cancelled) return;
        if (metricsRes.status === 'fulfilled') setMetrics(metricsRes.value);
        if (teamRes.status === 'fulfilled') setTeam(teamRes.value);
        if (placementsRes.status === 'fulfilled')
          setPlacements(placementsRes.value.items);
        if (contactRes.status === 'fulfilled') setContacts(contactRes.value.items);
        else if (canReadContacts)
          setContactsError(contactsErrorMessage(contactRes.reason));
        if (reqRes.status === 'fulfilled')
          setReqs(reqRes.value.items.filter((r) => !isClosedStatus(r.status)));
        else if (canReadReqs) setReqsError(reqsErrorMessage(reqRes.reason));
        if (actRes.status === 'fulfilled') setActivities(actRes.value.items);
        // §5 D4c — owner/team names from the directory (incl. departed).
        if (rosterRes.status === 'fulfilled') {
          setUserNames(rosterRes.value);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(detailErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, canReadContacts, canReadReqs, canReadActivity]);

  if (companyId === undefined) {
    return <InlineAlert variant="error">Missing company id in URL.</InlineAlert>;
  }
  if (loading) return <p className="rc-muted-line">Loading company…</p>;
  if (error !== null) {
    return (
      <section>
        <InlineAlert variant="error">{error}</InlineAlert>
        <p className="rc-mt-16">
          <Link to="/companies" className="rc-link-action">
            ← Back to companies
          </Link>
        </p>
      </section>
    );
  }
  if (company === null || session === null) return null;

  const canEdit = hasScope(session, 'company:edit');
  const canSeeCommercial = hasScope(session, 'company:read_commercial');

  // Inline in-place edit (ADR-0032, R6). Edit seeds the draft from the company
  // and flips the Overview cards to edit mode; Cancel discards the draft with no
  // mutation; Save diffs draft→company into the minimal PATCH and refreshes in
  // place. Commercial keys are dropped from the PATCH without commercial access.
  function startEdit(): void {
    if (company === null) return;
    setDraft(companyToDraft(company));
    setSaveError(null);
    setEditing(true);
    setActiveTab('overview'); // edit is in place on Overview (prototype startEdit)
  }
  function cancelEdit(): void {
    setEditing(false);
    setSaveError(null);
  }
  function onDraftChange(key: string, value: string): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  async function saveEdit(): Promise<void> {
    if (company === null) return;
    const body = draftToPatch(draft, company, canSeeCommercial);
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateCompany(company.id, body);
      setCompany(updated);
      setEditing(false);
    } catch (err) {
      setSaveError(updateErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  const canCreateContact = hasScope(session, 'contact:create');
  const canCreateReq = hasScope(session, 'requisition:create');
  const canEditContact = hasScope(session, 'contact:edit');
  const tier = tierLabel(company.client_tier);
  const since = clientSince(company);
  const ownerName =
    company.owner_id !== null ? (userNames[company.owner_id] ?? null) : null;

  const tabs: TabItem[] = [
    {
      id: 'overview',
      label: 'Overview',
      content: (
        <OverviewPanel
          company={company}
          editing={editing}
          draft={draft}
          onDraftChange={onDraftChange}
          onSave={saveEdit}
          onCancel={cancelEdit}
          saving={saving}
          saveError={saveError}
          contacts={contacts}
          ownerName={ownerName}
          team={team}
          userNames={userNames}
          canEditContact={canEditContact}
          canAssign={canAssign}
          canSeeCommercial={canSeeCommercial}
          onManageTeam={() => setActiveTab('account-team')}
        />
      ),
    },
  ];
  // Account team — the assignment-management surface as an in-page tab (matches
  // the prototype); reuses the CompanyAssignmentsView. Members here gate who can
  // see the client's requisitions (AUTHZ-D4b). 2nd tab, per the prototype order.
  tabs.push({
    id: 'account-team',
    label: `Account team (${team?.member_user_ids?.length ?? 0})`,
    content: (
      <div className="rc-mt-16">
        <CompanyAssignmentsView companyIdOverride={company.id} canManage={canAssign} />
      </div>
    ),
  });
  if (canReadContacts) {
    tabs.push({
      id: 'contacts',
      label: `Contacts (${contacts.length})`,
      content: (
        <ContactsPanel
          companyId={company.id}
          contacts={contacts}
          error={contactsError}
          canCreate={canCreateContact}
          canEdit={canEditContact}
        />
      ),
    });
  }
  if (canReadReqs) {
    tabs.push({
      id: 'jobs',
      label: `Requisitions (${reqs.length})`,
      content: <JobsPanel reqs={reqs} error={reqsError} />,
    });
    if (canReadPolicies && companyTypes(company).includes('CLIENT')) {
      tabs.push({
        id: 'policies',
        label: 'Policies',
        content: (
          <div className="rc-mt-16">
            <CompanyPoliciesView companyId={company.id} canConfigure={canConfigurePolicies} />
          </div>
        ),
      });
    }
    tabs.push({
      id: 'placements',
      label: `Placements (${placements.length})`,
      content: <PlacementsPanel placements={placements} />,
    });
  }
  if (canReadActivity) {
    tabs.push({
      id: 'activity',
      label: `Activity (${activities.length})`,
      content: <ActivityPanel activities={activities} />,
    });
  }
  if (canReadTasks) {
    tabs.push({
      id: 'tasks',
      label: 'Tasks',
      content: (
        <div className="rc-mt-16">
          <TasksPanel
            ownerType="company"
            ownerId={company.id}
            canWrite={scopes.includes('task:write')}
          />
        </div>
      ),
    });
  }

  return (
    <section>
      <div className="rc-dhead">
        <div className="rc-dhead__lead">
          <Avatar name={company.name} size="lg" />
          <div>
            <h1 className="rc-dhead__title">
              {company.name}
              {company.is_hot ? (
                <StatusPill tone="hot" icon={<Icons.IconFlame />}>
                  Hot
                </StatusPill>
              ) : null}
              {companyTypes(company).map((t) => (
                <StatusPill key={t} tone={REL_TYPE_TONES[t] ?? 'neutral'}>
                  {relTypeLabel(t)}
                </StatusPill>
              ))}
              {primaryStatus(company) !== null ? (
                <StatusPill
                  tone={REL_STATUS_TONES[primaryStatus(company) as string] ?? 'neutral'}
                  dot
                >
                  {relStatusLabel(primaryStatus(company) as string)}
                </StatusPill>
              ) : null}
              {tier !== null ? <StatusPill tone="brand">{tier}</StatusPill> : null}
            </h1>
            <div className="rc-dhead__co">
              <span>{locationOf(company)}</span>
              {company.url !== null && company.url !== '' ? (
                <a href={normalizeUrl(company.url)} target="_blank" rel="noreferrer">
                  {company.url}
                </a>
              ) : null}
              <span>Owner: {ownerName ?? '—'}</span>
              {since !== null ? <span>Client since {since}</span> : null}
            </div>
          </div>
        </div>
        <div className="rc-dhead__actions">
          {canCreateContact ? (
            <Link
              to={`/contacts/new?company_id=${company.id}`}
              className="rc-hbtn"
            >
              <Icons.IconContacts /> Add contact
            </Link>
          ) : null}
          {canCreateReq ? (
            <Link to="/requisitions/new" className="rc-hbtn">
              <Icons.IconRequisitions /> New requisition
            </Link>
          ) : null}
          {canEdit ? (
            <Button unstyled
              type="button"
              className={`rc-hbtn${editing ? ' rc-hbtn--on' : ''}`}
              onClick={editing ? cancelEdit : startEdit}
              aria-pressed={editing}
              data-testid="company-detail-edit"
            >
              <Icons.IconPencil /> {editing ? 'Editing' : 'Edit'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="rc-metrics rc-metrics--spaced rc-metrics--5">
        <MetricCard
          label="Open requisitions"
          value={metrics !== null ? metrics.open_reqs : canReadReqs ? reqs.length : '—'}
          icon={<Icons.IconRequisitions />}
          hint={
            metrics !== null
              ? `${metrics.openings} opening${metrics.openings === 1 ? '' : 's'}`
              : undefined
          }
        />
        <MetricCard
          label="Submitted"
          value={metrics !== null ? metrics.submitted : '—'}
          icon={<Icons.IconList />}
          hint="Last 30 days"
        />
        <MetricCard
          label="Active placements"
          value={metrics !== null ? metrics.active_placements : '—'}
          icon={<Icons.IconContacts />}
          hint={
            metrics !== null && metrics.active_placements > 0
              ? `${metrics.active_placements} started`
              : 'None started'
          }
        />
        <MetricCard
          label="Fill rate"
          value={
            metrics !== null && metrics.fill_rate !== null
              ? `${metrics.fill_rate}%`
              : '—'
          }
          icon={<Icons.IconBookmark />}
          hint={
            metrics !== null && metrics.fill_rate !== null
              ? `${metrics.filled}/${metrics.openings} filled`
              : 'No closed requisitions yet'
          }
        />
        <MetricCard
          label="Last activity"
          value={
            company.last_activity_at !== null ? lastContactLabel(company) : 'None yet'
          }
          icon={<Icons.IconClock />}
          hint={
            company.last_activity_at !== null
              ? undefined
              : 'No calls, emails or notes'
          }
        />
      </div>

      <div className="rc-mt-16">
        <Tabs
          items={tabs}
          ariaLabel="Company sections"
          initialId="overview"
          selectedId={activeTab}
          onSelectedChange={setActiveTab}
        />
      </div>
    </section>
  );
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Relationship status vocabulary offered in the inline editor (the workspace
// lifecycle set the detail hub exposes).
const REL_STATUS_OPTIONS = ['PROSPECT', 'ACTIVE', 'INACTIVE'] as const;
const REL_DESC: Record<string, string> = {
  CLIENT: 'Owns requisitions · receives submittals · placements',
  VENDOR: 'Supplies talent · staffing supplier',
  PARTNER: 'Strategic · referral · integration',
};

// A grid of Overview fields — each renders a read box (view) or its matching
// control (edit) at the same position via EF. `vals` is the draft when editing,
// the company's display strings when viewing (so read↔edit never shifts).
function FieldGrid({
  fields,
  vals,
  editing,
  onDraftChange,
  extra,
}: {
  readonly fields: readonly OverviewField[];
  readonly vals: OverviewDraft;
  readonly editing: boolean;
  readonly onDraftChange: (key: string, value: string) => void;
  readonly extra?: readonly OverviewField[];
}) {
  return (
    <div className="rc-rfgrid rc-mt-8">
      {fields.map((f) => (
        <EF
          key={f.key}
          field={f}
          value={vals[f.key] ?? ''}
          editing={editing}
          onChange={(v) => onDraftChange(f.key, v)}
        />
      ))}
      {/* Read-only-for-parity fields (no backend write path) stay a read box in
          both modes so the prototype layout is preserved without fabrication. */}
      {(extra ?? []).map((f) => (
        <EF key={f.key} field={f} value="" editing={editing} readOnly />
      ))}
    </div>
  );
}

// ── Overview ──
function OverviewPanel({
  company,
  editing,
  draft,
  onDraftChange,
  onSave,
  onCancel,
  saving,
  saveError,
  contacts,
  ownerName,
  team,
  userNames,
  canEditContact,
  canAssign,
  canSeeCommercial,
  onManageTeam,
}: {
  readonly company: CompanyView;
  readonly editing: boolean;
  readonly draft: OverviewDraft;
  readonly onDraftChange: (key: string, value: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly contacts: readonly ContactView[];
  readonly ownerName: string | null;
  readonly team: CompanyTeam | null;
  readonly userNames: Record<string, string>;
  readonly canEditContact: boolean;
  readonly canAssign: boolean;
  readonly canSeeCommercial: boolean;
  readonly onManageTeam: () => void;
}) {
  // In view mode the fields read from the company's display strings; in edit
  // mode from the live draft. companyToDraft gives display-ready strings for
  // every key (founded_year as text, exclusivity as Yes/No), so one shape backs
  // both — the box and the control occupy identical positions.
  const viewVals = useMemo(() => companyToDraft(company), [company]);
  const vals = editing ? draft : viewVals;
  const present = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(company, key);
  // Commercial terms are masked-by-absence: if the actor lacks commercial
  // access the keys are not on the company object at all. Render the card only
  // when at least one commercial key is present.
  const showCommercial = COMMERCIAL_FIELDS.some((f) => present(f.key));
  const rels = company.relationships ?? [];

  return (
    <div className="rc-mt-16 rc-ovgrid">
      <div className="rc-stack">
        {editing ? (
          <div className="rc-editbar" role="region" aria-label="Editing company">
            <Icons.IconPencil />
            <span className="rc-editbar__msg">
              <b>Editing {company.name}.</b> Changes take effect when you save and
              are logged to the audit trail. Nothing changes until you save.
            </span>
            <Button
              unstyled
              type="button"
              className="rc-btn rc-btn--sm"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              unstyled
              type="button"
              className="rc-btn rc-btn--sm rc-btn--primary"
              onClick={onSave}
              disabled={saving}
              data-testid="company-detail-save"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        ) : null}
        {editing && saveError !== null ? (
          <InlineAlert variant="error">{saveError}</InlineAlert>
        ) : null}

        <Card>
          <h3 className="rc-section-h">Company profile</h3>
          <FieldGrid
            fields={PROFILE_FIELDS}
            vals={vals}
            editing={editing}
            onDraftChange={onDraftChange}
            extra={[{ key: 'parent_company', label: 'Parent company' }]}
          />
          <EFAbout
            value={vals['description'] ?? ''}
            editing={editing}
            onChange={(v) => onDraftChange('description', v)}
          />
        </Card>

        <Card>
          <div className="rc-teamhd">
            <h3 className="rc-section-h">Relationships &amp; status</h3>
            <span className="rc-teamhd__manage rc-muted-line">
              Each relationship has its own status.
            </span>
          </div>
          <div className="rc-relstatus rc-mt-8">
            {(['CLIENT', 'VENDOR', 'PARTNER'] as const).map((t) => {
              const r = rels.find((x) => x.type === t);
              const on = editing
                ? draft[`rel_${t}`] === 'true'
                : r !== undefined;
              return (
                <div
                  key={t}
                  className={`rc-relstatus__row${!on ? ' rc-relstatus__row--off' : ''}`}
                >
                  <div>
                    {editing ? (
                      <label className="rc-relstatus__cb">
                        <Checkbox
                          checked={draft[`rel_${t}`] === 'true'}
                          onChange={(e) =>
                            onDraftChange(`rel_${t}`, e.target.checked ? 'true' : 'false')
                          }
                        />
                        <span className="rc-relstatus__t">{relTypeLabel(t)}</span>
                      </label>
                    ) : (
                      <div className="rc-relstatus__t">{relTypeLabel(t)}</div>
                    )}
                    <div className="rc-relstatus__d">{REL_DESC[t]}</div>
                  </div>
                  {editing ? (
                    <Select
                      unstyled
                      className="rc-ef__input rc-relstatus__sel"
                      value={draft[`rel_${t}_status`] ?? 'PROSPECT'}
                      disabled={draft[`rel_${t}`] !== 'true'}
                      aria-label={`${relTypeLabel(t)} status`}
                      onChange={(e) => onDraftChange(`rel_${t}_status`, e.target.value)}
                    >
                      {REL_STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {relStatusLabel(s)}
                        </option>
                      ))}
                    </Select>
                  ) : r !== undefined ? (
                    <StatusPill tone={REL_STATUS_TONES[r.status] ?? 'neutral'} dot>
                      {relStatusLabel(r.status)}
                    </StatusPill>
                  ) : (
                    <span className="rc-muted-line">Not set</span>
                  )}
                </div>
              );
            })}
          </div>
          {editing ? (
            <label className="rc-relstatus__cb rc-relstatus__dnc">
              <Checkbox
                checked={draft['communication_restricted'] === 'true'}
                onChange={(e) =>
                  onDraftChange(
                    'communication_restricted',
                    e.target.checked ? 'true' : 'false',
                  )
                }
              />
              <span>
                <strong>Do not contact</strong> — no contact at this company may be
                contacted
              </span>
            </label>
          ) : (
            <p className="rc-footnote">
              <strong>Do not contact</strong>{' '}
              {company.communication_restricted
                ? 'On — no contact at this company may be contacted.'
                : 'Off — contacts at this company may be contacted.'}
            </p>
          )}
        </Card>

        <Card>
          <h3 className="rc-section-h">Headquarters</h3>
          <FieldGrid
            fields={HQ_FIELDS}
            vals={vals}
            editing={editing}
            onDraftChange={onDraftChange}
          />
        </Card>

        <Card>
          <h3 className="rc-section-h">Supplier &amp; program</h3>
          <FieldGrid
            fields={SUPPLIER_FIELDS}
            vals={vals}
            editing={editing}
            onDraftChange={onDraftChange}
            extra={[
              { key: 'msp_vms', label: 'MSP / VMS' },
              { key: 'vendor_number', label: 'Vendor number' },
            ]}
          />
        </Card>

        {showCommercial ? (
          <Card>
            <div className="rc-teamhd">
              <h3 className="rc-section-h">Commercial terms</h3>
              <span className="rc-card__sens">RESTRICTED</span>
            </div>
            <FieldGrid
              fields={COMMERCIAL_FIELDS}
              vals={vals}
              editing={editing && canSeeCommercial}
              onDraftChange={onDraftChange}
            />
            <p className="rc-footnote">Visible to users with commercial access.</p>
          </Card>
        ) : null}
      </div>

      <div className="rc-stack">
        <Card>
          <div className="rc-teamhd">
            <h3 className="rc-section-h">Account team</h3>
            {/* Switch to the in-page Account team tab (prototype goTeam) — the
                members there gate who can see the client's requisitions
                (AUTHZ-D4b). "Manage" when the actor can assign, else "View". */}
            <Button
              unstyled
              type="button"
              className="rc-link-strong rc-teamhd__manage"
              onClick={onManageTeam}
              data-testid="overview-manage-team"
            >
              {canAssign ? 'Manage' : 'View'}
            </Button>
          </div>
          <ul className="rc-detail-list rc-mt-8">
            <li className="rc-tmrow">
              <Avatar name={ownerName ?? 'Unassigned'} size="sm" />
              <div>
                <div className="rc-tmrow__nm">{ownerName ?? 'Unassigned'}</div>
                <div className="rc-tmrow__rl">Account owner</div>
              </div>
            </li>
            {(team?.member_user_ids ?? [])
              .filter((uid) => uid !== company.owner_id)
              .map((uid) => (
                <li key={uid} className="rc-tmrow">
                  <Avatar name={userNames[uid] ?? 'Team member'} size="sm" />
                  <div>
                    <div className="rc-tmrow__nm">
                      {userNames[uid] ?? 'Team member'}
                    </div>
                    <div className="rc-tmrow__rl">Assigned</div>
                  </div>
                </li>
              ))}
          </ul>
          <p className="rc-footnote">
            Members can see and work on this client&rsquo;s requisitions.
          </p>
        </Card>

        <Card>
          <div className="rc-teamhd">
            <h3 className="rc-section-h">Key contacts</h3>
            <Link
              to={`/contacts?company_id=${company.id}`}
              className="rc-link-strong rc-teamhd__manage"
            >
              All contacts
            </Link>
          </div>
          {contacts.length === 0 ? (
            <p className="rc-empty">No contacts on this account yet.</p>
          ) : (
            <ul className="rc-detail-list rc-mt-8">
              {contacts.slice(0, 4).map((c) => (
                <li key={c.id} className="rc-tmrow">
                  <Avatar name={fullContactName(c)} size="sm" />
                  <div>
                    <div className="rc-tmrow__nm">
                      {fullContactName(c)}
                      {c.is_primary ? (
                        <span className="rc-primary-badge">PRIMARY</span>
                      ) : null}
                    </div>
                    <div className="rc-tmrow__rl">
                      {display(c.title)}
                      {canEditContact ? (
                        <>
                          {' · '}
                          <Link to={`/contacts?edit=${c.id}`}>Edit</Link>
                        </>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}


// ── Contacts ──
function ContactsPanel({
  companyId,
  contacts,
  error,
  canCreate,
  canEdit,
}: {
  readonly companyId: string;
  readonly contacts: readonly ContactView[];
  readonly error: string | null;
  readonly canCreate: boolean;
  readonly canEdit: boolean;
}) {
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Contacts</h2>
          {canCreate ? (
            <div className="rc-card__head-actions">
              <Link
                to={`/contacts/new?company_id=${companyId}`}
                className="rc-hbtn"
              >
                <Icons.IconPlus /> Add contact
              </Link>
            </div>
          ) : null}
        </div>
        {contacts.length === 0 ? (
          <p className="rc-empty">No contacts for this company yet.</p>
        ) : (
          <div className="rc-tablewrap">
            <table className="rc-table">
              <thead>
                <tr>
                  <th scope="col">Contact</th>
                  <th scope="col">Title</th>
                  <th scope="col">Email</th>
                  <th scope="col">Phone</th>
                  {canEdit ? <th scope="col" aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => {
                  const phone =
                    c.phone_work ?? c.phone_cell ?? c.phone_other ?? null;
                  return (
                    <tr key={c.id}>
                      <td>
                        <span className="rc-ent">
                          <Avatar name={fullContactName(c)} size="sm" />
                          <span className="rc-ent__nm">
                            {fullContactName(c)}
                            {c.left_company ? ' · (left company)' : ''}
                            {c.is_primary ? (
                              <span className="rc-primary-badge">PRIMARY</span>
                            ) : null}
                          </span>
                        </span>
                      </td>
                      <td>{display(c.title)}</td>
                      <td>
                        {c.email1 !== null && c.email1 !== '' ? (
                          <a href={`mailto:${c.email1}`} className="rc-link-strong">
                            {c.email1}
                          </a>
                        ) : (
                          <span className="rc-consent-stub">—</span>
                        )}
                      </td>
                      <td>
                        {phone !== null && phone !== '' ? (
                          phone
                        ) : (
                          <span className="rc-consent-stub">—</span>
                        )}
                      </td>
                      {canEdit ? (
                        <td>
                          <Link to={`/contacts?edit=${c.id}`} className="rc-link-action">
                            Edit
                          </Link>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Jobs (assigned requisitions) ──
function JobsPanel({
  reqs,
  error,
}: {
  readonly reqs: readonly RequisitionView[];
  readonly error: string | null;
}) {
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Open requisitions</h2>
        </div>
        {reqs.length === 0 ? (
          <p className="rc-empty">No active requisitions for this company yet.</p>
        ) : (
          <div className="rc-tablewrap">
            <table className="rc-table">
              <thead>
                <tr>
                  <th scope="col">Requisition</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">In pipeline</th>
                  <th scope="col" className="num">Openings</th>
                </tr>
              </thead>
              <tbody>
                {reqs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/requisitions/${r.id}`} className="rc-link-strong">
                        {r.title}
                      </Link>
                    </td>
                    <td>
                      <StatusPill tone="neutral" dot>
                        {r.status}
                      </StatusPill>
                    </td>
                    {/* In-pipeline count is a per-requisition pipeline read not
                        loaded on this surface — shown as "—" for now. */}
                    <td className="num">
                      <span className="rc-consent-stub">—</span>
                    </td>
                    <td className="num">{r.openings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Activity (confirmed-but-empty — no company write path today) ──
function ActivityPanel({
  activities,
}: {
  readonly activities: readonly ActivityView[];
}) {
  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Activity</h2>
        </div>
        {activities.length === 0 ? (
          <p className="rc-empty">No activity recorded for this company yet.</p>
        ) : (
          <ul className="rc-detail-list rc-detail-list--flush">
            {activities.map((a) => (
              <li key={a.id} className="rc-tmrow rc-tmrow--row">
                <div className="rc-tmrow__body">
                  <div className="rc-tmrow__nm">{a.notes ?? a.type}</div>
                  <div className="rc-tmrow__rl">
                    <time dateTime={a.created_at}>{a.created_at}</time>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ── Placements (established placements at the company's reqs) ──
function PlacementsPanel({
  placements,
}: {
  readonly placements: readonly CompanyPlacement[];
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = [...new Set(placements.map((p) => p.talent_record_id))];
    if (ids.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(ids.map((id) => getTalent(id))).then((rs) => {
      if (cancelled) return;
      const m: Record<string, string> = {};
      rs.forEach((r, i) => {
        const id = ids[i];
        if (id !== undefined && r.status === 'fulfilled') {
          m[id] = `${r.value.first_name} ${r.value.last_name}`.trim();
        }
      });
      setNames(m);
    });
    return () => {
      cancelled = true;
    };
  }, [placements]);

  return (
    <div className="rc-mt-16">
      <Card flush>
        <div className="rc-card__head">
          <h2>Placements</h2>
        </div>
        {placements.length === 0 ? (
          <p className="rc-empty">No active placements at this company yet.</p>
        ) : (
          <ul className="rc-detail-list rc-detail-list--flush">
            {placements.map((p) => {
              const name = names[p.talent_record_id] ?? 'Talent';
              return (
                <li key={p.placement_process_id} className="rc-tmrow rc-tmrow--row">
                  <Avatar name={name} size="sm" />
                  <div className="rc-tmrow__body">
                    <div className="rc-tmrow__nm">
                      <Link
                        to={`/talent/${p.talent_record_id}`}
                        className="rc-link-strong"
                      >
                        {name}
                      </Link>
                    </div>
                    <div className="rc-tmrow__rl">{p.requisition_title}</div>
                  </div>
                  <StatusPill tone="ok" dot>
                    Placed
                  </StatusPill>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
