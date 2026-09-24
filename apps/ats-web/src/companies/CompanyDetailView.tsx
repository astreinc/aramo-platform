import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  InlineAlert,
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
import type { CompanyView, ContactView, UpdateCompanyRequest } from './types';
import { CompanyForm } from './CompanyForm';
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

// Company DETAIL — rebuilt to the locked Confident-Blue "account hub" mockup.
// Header (logo + relationship/tier/hot pills + meta + actions) · honest KPI
// strip (Open reqs / Contacts / Tier / Last contact — only what real fields
// back) · a ReservedSeam "account briefing" (R10 — Aramo Core writes the
// reasoning later; never fabricated here) · tabs Overview / Contacts / Jobs /
// Activity / Tasks (each scope-gated; a tab the actor can't read is hidden).
//
// FE-only. Omitted vs the mockup (no backend field): revenue, fill-rate,
// active-placements, submittals-pending, off-limits, multi-person account team,
// Placements tab. Activity stays confirmed-but-empty (no company write path —
// CreateNoteRequest excludes 'company'), so there is no "Log note" action here.

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
  // Company Party/Role (ADR-0032, R6) — "Full Edit Company" makes the hub
  // editable IN PLACE (all fields, one Save), mirroring the requisition detail
  // edit affordance — not a separate page, not the quick-edit drawer.
  const [editOpen, setEditOpen] = useState(false);
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

  // Company Party/Role (ADR-0032, R6) — "Full Edit Company" save. PATCHes the
  // full field set, refreshes the hub in place, and exits edit mode.
  async function onFullEdit(body: UpdateCompanyRequest): Promise<void> {
    if (company === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateCompany(company.id, body);
      setCompany(updated);
      setEditOpen(false);
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
          contacts={contacts}
          ownerName={ownerName}
          team={team}
          userNames={userNames}
          canEditContact={canEditContact}
          canAssign={canAssign}
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
        <CompanyAssignmentsView companyIdOverride={company.id} />
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
              <Icons.IconRequisitions /> New req
            </Link>
          ) : null}
          {canEdit ? (
            <Button unstyled
              type="button"
              className="rc-hbtn"
              onClick={() => setEditOpen(true)}
              data-testid="company-detail-edit"
            >
              <Icons.IconPencil /> Edit
            </Button>
          ) : null}
        </div>
      </div>

      {editOpen ? (
        <Card>
          {saveError !== null ? (
            <InlineAlert variant="error">{saveError}</InlineAlert>
          ) : null}
          <CompanyForm
            mode="edit"
            initial={company}
            onSubmit={onFullEdit}
            onCancel={() => {
              setEditOpen(false);
              setSaveError(null);
            }}
            submitting={saving}
            submitError={saveError}
            canSeeCommercial={canSeeCommercial}
          />
        </Card>
      ) : (
        <>
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
        <Tabs items={tabs} ariaLabel="Company sections" initialId="overview" />
      </div>
        </>
      )}
    </section>
  );
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// ── Overview ──
function OverviewPanel({
  company,
  contacts,
  ownerName,
  team,
  userNames,
  canEditContact,
  canAssign,
}: {
  readonly company: CompanyView;
  readonly contacts: readonly ContactView[];
  readonly ownerName: string | null;
  readonly team: CompanyTeam | null;
  readonly userNames: Record<string, string>;
  readonly canEditContact: boolean;
  readonly canAssign: boolean;
}) {
  const about = company.description ?? company.notes;
  const present = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(company, key);
  const commercialKeys: [string, string][] = [
    ['fee_model', 'Fee model'],
    ['payment_terms', 'Payment terms'],
    ['default_contract_markup_pct', 'Contract markup %'],
    ['default_perm_fee_pct', 'Perm fee %'],
    ['credit_status', 'Credit status'],
    ['default_currency', 'Currency'],
  ];
  const record = company as unknown as Record<string, unknown>;
  const commercialRows = commercialKeys.filter(([k]) => present(k));

  return (
    <div className="rc-mt-16 rc-ovgrid">
      <div className="rc-stack">
        <Card>
          <h3 className="rc-section-h">Company profile</h3>
          <div className="rc-rfgrid rc-mt-8">
            <RF label="Company name" value={company.name} />
            <RF label="Website" value={display(company.url)} />
            <RF label="Industry" value={display(company.industry)} />
            <RF label="Employees" value={display(company.employee_count_band)} />
            <RF label="Revenue band" value={display(company.annual_revenue_band)} />
            <RF
              label="Founded"
              value={company.founded_year !== null ? String(company.founded_year) : '—'}
            />
            <RF label="Ownership" value={display(company.ownership_type)} />
            <RF label="Parent company" value="—" />
          </div>
          <div className="rc-rf rc-rf--full rc-mt-8">
            <div className="rc-rf__lb">About</div>
            <div className={`rc-rf__v${about === null || about === '' ? ' rc-rf__v--empty' : ''}`}>
              {about !== null && about !== '' ? about : '—'}
            </div>
          </div>
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
              const r = (company.relationships ?? []).find((x) => x.type === t);
              const desc =
                t === 'CLIENT'
                  ? 'Owns requisitions · receives submittals · placements'
                  : t === 'VENDOR'
                    ? 'Supplies talent · staffing supplier'
                    : 'Strategic · referral · integration';
              return (
                <div
                  key={t}
                  className={`rc-relstatus__row${r === undefined ? ' rc-relstatus__row--off' : ''}`}
                >
                  <div>
                    <div className="rc-relstatus__t">{relTypeLabel(t)}</div>
                    <div className="rc-relstatus__d">{desc}</div>
                  </div>
                  {r !== undefined ? (
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
          <p className="rc-footnote">
            <strong>Do not contact</strong>{' '}
            {company.communication_restricted
              ? 'On — no contact at this company may be contacted.'
              : 'Off — contacts at this company may be contacted.'}
          </p>
        </Card>

        <Card>
          <h3 className="rc-section-h">Headquarters</h3>
          <div className="rc-rfgrid rc-mt-8">
            <RF label="Street address" value={display(company.address)} />
            <RF label="City" value={display(company.city)} />
            <RF label="State" value={display(company.state)} />
            <RF label="ZIP / Postal code" value={display(company.zip)} />
            <RF label="Country" value={display(company.country)} />
          </div>
        </Card>

        {commercialRows.length > 0 ? (
          <Card>
            <div className="rc-teamhd">
              <h3 className="rc-section-h">Commercial terms</h3>
              <span className="rc-card__sens">RESTRICTED</span>
            </div>
            <dl className="rc-deflist rc-mt-8">
              {commercialRows.map(([key, label]) => {
                const raw = record[key];
                const v =
                  raw === null || raw === undefined || raw === ''
                    ? '—'
                    : String(raw);
                return <KV key={key} k={label} v={v} />;
              })}
            </dl>
            <p className="rc-footnote">
              Visible to users with commercial access.
            </p>
          </Card>
        ) : null}
      </div>

      <div className="rc-stack">
        <Card>
          <div className="rc-teamhd">
            <h3 className="rc-section-h">Account team</h3>
            {/* Assign users to this client (company:assign) — the members here
                gate who can see the client's requisitions (AUTHZ-D4b). */}
            {canAssign ? (
              <Link
                to={`/companies/${company.id}/assignments`}
                className="rc-link-strong rc-teamhd__manage"
              >
                Manage
              </Link>
            ) : null}
          </div>
          <ul className="rc-detail-list rc-mt-8">
            <li className="rc-tmrow">
              <Avatar name={ownerName ?? 'Unassigned'} size="md" />
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


function KV({ k, v }: { readonly k: string; readonly v: string }) {
  return (
    <div className="rc-defrow">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

// A read-view field — label over a bordered value box (the prototype's profile /
// HQ field look). Inline field-flip editing is a separate deferred slice.
function RF({
  label,
  value,
  full,
}: {
  readonly label: string;
  readonly value: string;
  readonly full?: boolean;
}) {
  const empty = value === '' || value === '—';
  return (
    <div className={`rc-rf${full ? ' rc-rf--full' : ''}`}>
      <div className="rc-rf__lb">{label}</div>
      <div className={`rc-rf__v${empty ? ' rc-rf__v--empty' : ''}`}>
        {empty ? '—' : value}
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
