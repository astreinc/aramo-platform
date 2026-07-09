import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { Tabs, type TabItem } from '@aramo/fe-foundation';

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
  ReservedSeam,
  StatusPill,
  Tag,
} from '../ui';

import {
  getCompany,
  getCompanyPlacements,
  getCompanyTeam,
  getOneCompanyMetrics,
  listContactsForCompany,
} from './companies-api';
import {
  contactsErrorMessage,
  detailErrorMessage,
  reqsErrorMessage,
} from './error-messages';
import type { CompanyView, ContactView } from './types';
import {
  RELATIONSHIP_TONES,
  accountBriefing,
  lastContactLabel,
  locationOf,
  relationshipLabel,
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
        />
      ),
    },
  ];
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
      label: `Jobs (${reqs.length})`,
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
      <p className="rc-mb-8">
        <Link to="/companies" className="rc-link-action">
          ← Back to companies
        </Link>
      </p>

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
              <StatusPill tone={RELATIONSHIP_TONES[company.status] ?? 'neutral'} dot>
                {relationshipLabel(company.status)}
              </StatusPill>
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
              to={`/companies/${company.id}/contacts/new`}
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
            <Link to={`/companies/${company.id}/edit`} className="rc-hbtn">
              <Icons.IconPencil /> Edit
            </Link>
          ) : null}
        </div>
      </div>

      {company.off_limits ? (
        <div className="rc-offlimits" role="note">
          <Icons.IconShield />
          <span>
            <strong>Off-limits.</strong> This client&rsquo;s own employees are
            excluded from sourcing working sets.
          </span>
        </div>
      ) : null}

      <div className="rc-metrics rc-metrics--spaced rc-metrics--6">
        <MetricCard
          label="Open reqs"
          value={metrics !== null ? metrics.open_reqs : canReadReqs ? reqs.length : '—'}
          icon={<Icons.IconRequisitions />}
        />
        <MetricCard
          label="Active placements"
          value={metrics !== null ? metrics.active_placements : '—'}
          icon={<Icons.IconContacts />}
        />
        <MetricCard
          label="Submitted"
          value={metrics !== null ? metrics.submitted : '—'}
          icon={<Icons.IconList />}
        />
        <MetricCard
          label="Fill rate"
          value={
            metrics !== null && metrics.fill_rate !== null
              ? `${metrics.fill_rate}%`
              : '—'
          }
          icon={<Icons.IconBookmark />}
        />
        <MetricCard
          label="Last contact"
          value={lastContactLabel(company)}
          icon={<Icons.IconClock />}
        />
        <MetricCard
          label="Revenue band"
          value={display(company.annual_revenue_band)}
          icon={<Icons.IconCompanies />}
          hint="firmographic"
        />
      </div>

      {/* Account briefing — deterministic, facts only (counts / fill-rate /
          last-contact). No evaluative verdict on the account (no health/tier/
          quality judgement — R10; rating disposition DDR §11). The ReservedSeam
          beneath reserves the richer Core reasoning. */}
      <div className="rc-brief">
        <div className="rc-brief__ic" aria-hidden="true">
          <Icons.IconBolt />
        </div>
        <p className="rc-brief__text">{accountBriefing(company, metrics)}</p>
      </div>
      <ReservedSeam title="Account briefing" tag="Integrates with Core later">
        When Aramo Core is connected, its richer account reasoning — the evidence
        behind a suggested next move, never a fabricated metric — appears here.
      </ReservedSeam>

      <div className="rc-mt-16">
        <Tabs items={tabs} ariaLabel="Company sections" initialId="overview" />
      </div>
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
}: {
  readonly company: CompanyView;
  readonly contacts: readonly ContactView[];
  readonly ownerName: string | null;
  readonly team: CompanyTeam | null;
  readonly userNames: Record<string, string>;
  readonly canEditContact: boolean;
}) {
  const about = company.description ?? company.notes;
  const tags = company.tags ?? [];
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
          <h3 className="rc-section-h">About</h3>
          <p className="rc-about rc-mt-8">
            {about !== null && about !== '' ? about : 'No description on file.'}
          </p>
          {tags.length > 0 ? (
            <div className="rc-tags rc-mt-8">
              {tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>
          ) : null}
        </Card>

        <Card>
          <h3 className="rc-section-h">Key facts</h3>
          <dl className="rc-deflist rc-mt-8">
            <KV k="Industry" v={display(company.industry)} />
            <KV k="Headquarters" v={locationOf(company)} />
            <KV k="Country" v={display(company.country)} />
            <KV k="Employees" v={display(company.employee_count_band)} />
            <KV k="Revenue band" v={display(company.annual_revenue_band)} />
            <KV
              k="Founded"
              v={company.founded_year !== null ? String(company.founded_year) : '—'}
            />
            <KV k="Ownership" v={display(company.ownership_type)} />
            <KV k="Supplier status" v={display(company.supplier_status)} />
            <KV k="Exclusive" v={company.exclusivity ? 'Yes' : 'No'} />
          </dl>
        </Card>

        {commercialRows.length > 0 ? (
          <Card>
            <h3 className="rc-section-h">Commercial terms</h3>
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
              Commercial terms are visible only with company:read_commercial.
            </p>
          </Card>
        ) : null}
      </div>

      <div className="rc-stack">
        <Card>
          <h3 className="rc-section-h">Account team</h3>
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
        </Card>

        <Card>
          <h3 className="rc-section-h">Key contacts</h3>
          {contacts.length === 0 ? (
            <p className="rc-empty">No contacts on this account yet.</p>
          ) : (
            <ul className="rc-detail-list rc-mt-8">
              {contacts.slice(0, 4).map((c) => (
                <li key={c.id} className="rc-tmrow">
                  <Avatar name={fullContactName(c)} size="sm" />
                  <div>
                    <div className="rc-tmrow__nm">{fullContactName(c)}</div>
                    <div className="rc-tmrow__rl">
                      {display(c.title)}
                      {canEditContact ? (
                        <>
                          {' · '}
                          <Link to={`/contacts/${c.id}/edit`}>Edit</Link>
                        </>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h3 className="rc-section-h">Next steps</h3>
          <p className="rc-muted-line rc-mt-8">{nextSteps(company)}</p>
        </Card>
      </div>
    </div>
  );
}

function nextSteps(c: CompanyView): string {
  if (c.next_action_at !== null) {
    const d = new Date(c.next_action_at);
    if (!Number.isNaN(d.getTime())) {
      return `Next action scheduled for ${d.toLocaleDateString()}.`;
    }
  }
  if (c.status === 'prospect')
    return 'Advance the BD conversation and scope a first requisition.';
  if (c.status === 'inactive')
    return 'Dormant account — consider a re-engagement note.';
  return 'Keep open requisitions moving and confirm upcoming interviews.';
}

function KV({ k, v }: { readonly k: string; readonly v: string }) {
  return (
    <div className="rc-defrow">
      <dt>{k}</dt>
      <dd>{v}</dd>
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
                to={`/companies/${companyId}/contacts/new`}
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
          <ul className="rc-detail-list rc-detail-list--flush">
            {contacts.map((c) => (
              <li key={c.id} className="rc-tmrow rc-tmrow--row">
                <Avatar name={fullContactName(c)} size="sm" />
                <div className="rc-tmrow__body">
                  <div className="rc-tmrow__nm">
                    {fullContactName(c)}
                    {c.left_company ? ' · (left company)' : ''}
                  </div>
                  <div className="rc-tmrow__rl">
                    {display(c.title)}
                    {c.email1 !== null && c.email1 !== '' ? ` · ${c.email1}` : ''}
                  </div>
                </div>
                {canEdit ? (
                  <Link to={`/contacts/${c.id}/edit`} className="rc-link-action">
                    Edit
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
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
          <ul className="rc-detail-list rc-detail-list--flush">
            {reqs.map((r) => (
              <li key={r.id} className="rc-tmrow rc-tmrow--row">
                <div className="rc-tmrow__body">
                  <div className="rc-tmrow__nm">
                    <Link to={`/requisitions/${r.id}`} className="rc-link-strong">
                      {r.title}
                    </Link>
                  </div>
                  <div className="rc-tmrow__rl">{r.status}</div>
                </div>
              </li>
            ))}
          </ul>
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

// ── Placements (placed pipelines at the company's reqs) ──
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
                <li key={p.pipeline_id} className="rc-tmrow rc-tmrow--row">
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
