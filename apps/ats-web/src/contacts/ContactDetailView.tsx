import {
  Button,
  Dialog,
  FormField,
  InlineAlert,
  hasScope,
  useSession,
  useToast,
  type Session,
} from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Tabs, type TabItem } from '@aramo/fe-foundation';

import { listActivities, createNote } from '../activity/activity-api';
import type { ActivityView } from '../activity/types';
import { getCompanyTeam } from '../companies/companies-api';
import type { CompanyTeam } from '../companies/company-workspace';
import { resolveUserNames } from '../users/users-api';
import {
  ActivityFeed,
  Avatar,
  Card,
  CardHead,
  Icons,
  MetricCard,
  StatusPill,
  type ActivityFeedItem,
} from '../ui';
import { useEntityCrumb } from '../shell/breadcrumb';
import type { ContactView } from '../companies/types';

import { getContact } from './contacts-api';
import { detailErrorMessage } from './error-messages';
import {
  FULL_NAME,
  contactBriefing,
  isContactable,
  lastContactLabel,
  preferenceLabel,
  preferenceTone,
  roleLabel,
  ROLE_TONES,
} from './contact-workspace';

// Contact relationship hub — the wired DETAIL surface (GET /v1/contacts/:id,
// contact:read; invisible/cross-tenant → 404). Header + facts-only briefing +
// metric strip + tabs (Overview · Activity). The account team REUSES the
// Companies team read, keyed by the CONTACT'S company. The activity timeline is
// polymorphic on subject_type='contact'. NO talent-pipeline stage pills (a
// contact is not in a pipeline), NO fabricated open-reqs.

interface ContactDetailViewProps {
  readonly sessionOverride?: Session;
}

export function ContactDetailView({ sessionOverride }: ContactDetailViewProps = {}) {
  const { contactId } = useParams<{ contactId: string }>();
  const [contact, setContact] = useState<ContactView | null>(null);
  const [team, setTeam] = useState<CompanyTeam | null>(null);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [activities, setActivities] = useState<readonly ActivityView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const [refreshKey, setRefreshKey] = useState(0);

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canEdit =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'contact:edit');
  const canLogNote =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'activity:create');

  useEntityCrumb(contact !== null ? FULL_NAME(contact) : null);

  useEffect(() => {
    if (contactId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getContact(contactId)
      .then(async (c) => {
        if (cancelled) return;
        setContact(c);
        setLoading(false);
        // Secondary surfaces — all best-effort (allSettled; graceful 403/404).
        const [teamRes, namesRes, actRes] = await Promise.allSettled([
          getCompanyTeam(c.company_id),
          resolveUserNames(),
          listActivities('contact', c.id),
        ]);
        if (cancelled) return;
        if (teamRes.status === 'fulfilled') setTeam(teamRes.value);
        // §5 D4c — owner/team names from the directory (incl. departed).
        if (namesRes.status === 'fulfilled') setUserNames(namesRes.value);
        if (actRes.status === 'fulfilled') setActivities(actRes.value.items);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(detailErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  if (loading) return <p className="rc-muted-line">Loading contact…</p>;
  if (error !== null) {
    return (
      <section>
        <InlineAlert variant="error">{error}</InlineAlert>
        <p className="rc-mt-16">
          <Link to="/contacts" className="rc-link-action">
            ← Back to contacts
          </Link>
        </p>
      </section>
    );
  }
  if (contact === null) return null;

  const role = roleLabel(contact.relationship_role);
  const ownerLabel =
    contact.owner_id !== null ? (userNames[contact.owner_id] ?? '—') : '—';
  const contactable = isContactable(contact);

  const tabs: TabItem[] = [
    {
      id: 'overview',
      label: 'Overview',
      content: (
        <OverviewPanel
          contact={contact}
          team={team}
          userNames={userNames}
          ownerLabel={ownerLabel}
        />
      ),
    },
    {
      id: 'activity',
      label: `Activity (${activities.length})`,
      content: (
        <div className="rc-mt-16">
          <div className="rc-viewhead">
            <h2 className="rc-section-h">Activity</h2>
            {canLogNote ? (
              <div className="rc-viewhead__actions">
                <ContactNoteDialog contactId={contact.id} onSaved={refresh} />
              </div>
            ) : null}
          </div>
          {activities.length === 0 ? (
            <p className="rc-empty">No activity logged for this contact yet.</p>
          ) : (
            <ActivityFeed items={activities.map(toFeedItem)} />
          )}
        </div>
      ),
    },
  ];

  return (
    <section>
      <p className="rc-mt-8">
        <Link to="/contacts" className="rc-link-action">
          ← Back to contacts
        </Link>
      </p>

      <div className="rc-dhead">
        <div>
          <h1 className="rc-dhead__title">
            {FULL_NAME(contact)}
            {contact.is_hot ? (
              <StatusPill tone="hot" icon={<Icons.IconFlame />}>
                Hot
              </StatusPill>
            ) : null}
            {role !== null ? (
              <StatusPill
                tone={ROLE_TONES[contact.relationship_role ?? ''] ?? 'neutral'}
                dot
              >
                {role}
              </StatusPill>
            ) : null}
            <StatusPill tone={preferenceTone(contact.preference)}>
              {preferenceLabel(contact.preference)}
            </StatusPill>
          </h1>
          <div className="rc-dhead__co">
            <Icons.IconCompanies />
            <Link to={`/companies/${contact.company_id}`}>
              {contact.company_name ?? 'Company'}
            </Link>
            {contact.title !== null ? (
              <span className="mono">· {contact.title}</span>
            ) : null}
          </div>
        </div>
        <div className="rc-dhead__actions">
          {canEdit ? (
            <Link to={`/contacts/${contact.id}/edit`} className="rc-hbtn">
              <Icons.IconPencil />
              Edit
            </Link>
          ) : null}
        </div>
      </div>

      {!contactable ? (
        <div className="rc-banner rc-banner--warn rc-mt-16" role="note">
          <Icons.IconBan aria-hidden="true" />
          <span>
            <strong>Do-not-contact.</strong> {FULL_NAME(contact)} asked not to be
            contacted. Calls and sequences are blocked for this record — honoring
            the preference is a compliance and trust safeguard.
          </span>
        </div>
      ) : null}

      {/* Facts-only briefing — no AI-assisted framing, no relationship-quality
          verdict, no suggested next move (the Companies-briefing ruling). */}
      <Card className="rc-mt-16">
        <p className="rc-brief-fact">{contactBriefing(contact)}</p>
      </Card>

      <div className="rc-metrics rc-mt-16">
        <MetricCard
          label="Last contact"
          value={lastContactLabel(contact)}
          icon={<Icons.IconClock />}
        />
        <MetricCard
          label="Company"
          value={contact.company_name ?? '—'}
          icon={<Icons.IconCompanies />}
        />
        <MetricCard label="Owner" value={ownerLabel} icon={<Icons.IconUser />} />
        <MetricCard
          label="Communication"
          value={preferenceLabel(contact.preference)}
          icon={<Icons.IconShield />}
        />
      </div>

      <div className="rc-mt-16">
        <Tabs
          items={tabs}
          ariaLabel="Contact sections"
          initialId="overview"
          selectedId={tab}
          onSelectedChange={setTab}
        />
      </div>
    </section>
  );
}

// ── Overview panel ──
function OverviewPanel({
  contact,
  team,
  userNames,
  ownerLabel,
}: {
  readonly contact: ContactView;
  readonly team: CompanyTeam | null;
  readonly userNames: Record<string, string>;
  readonly ownerLabel: string;
}) {
  const contactable = isContactable(contact);
  const teamMembers = team?.member_user_ids ?? [];
  return (
    <div className="rc-ovgrid rc-mt-16">
      <div>
        <Card>
          <CardHead title="Contact details" />
          <dl className="rc-kv">
            <dt>Email</dt>
            <dd>{contact.email1 ?? '—'}</dd>
            <dt>Work phone</dt>
            <dd className="mono">{contact.phone_work ?? '—'}</dd>
            <dt>Mobile</dt>
            <dd className="mono">{contact.phone_cell ?? '—'}</dd>
            <dt>Location</dt>
            <dd>{contact.address ?? '—'}</dd>
          </dl>
        </Card>

        <Card className="rc-mt-16">
          <CardHead title="Position" />
          <dl className="rc-kv">
            <dt>Title</dt>
            <dd>{contact.title ?? '—'}</dd>
            <dt>Company</dt>
            <dd>
              <Link
                to={`/companies/${contact.company_id}`}
                className="rc-link-strong"
              >
                {contact.company_name ?? 'Company'}
              </Link>
            </dd>
            <dt>Status</dt>
            <dd>{contact.left_company ? 'Former contact' : 'Active'}</dd>
          </dl>
        </Card>

        <Card className="rc-mt-16">
          <CardHead title="Relationship" />
          <dl className="rc-kv">
            <dt>Role</dt>
            <dd>{roleLabel(contact.relationship_role) ?? 'Unclassified'}</dd>
            <dt>Account owner</dt>
            <dd>{ownerLabel}</dd>
            <dt>Last contact</dt>
            <dd>{lastContactLabel(contact)}</dd>
          </dl>
          <p className="rc-footnote">
            Relationship role reflects this person’s part in the account — Aramo
            applies no quality rating to people.
          </p>
        </Card>
      </div>

      <div>
        <Card>
          <CardHead title="Communication" />
          <div className="rc-pad">
            <StatusPill tone={preferenceTone(contact.preference)} dot>
              {preferenceLabel(contact.preference)}
            </StatusPill>
            <p className="rc-mt-8 rc-muted-line">
              {contactable
                ? contact.preference === 'limited'
                  ? 'Prefers limited, async contact — email over calls; no high-frequency sequences.'
                  : 'Cleared for calls, email, and contact sequences.'
                : 'Asked not to be contacted. Calls and sequences are blocked for this record.'}
            </p>
          </div>
        </Card>

        <Card className="rc-mt-16">
          <CardHead title="Account team" />
          {team === null ? (
            <p className="rc-pad rc-muted-line">
              Account team is not available.
            </p>
          ) : (
            <div className="rc-teamrows">
              <TeamRow
                label={
                  team.owner_id !== null
                    ? (userNames[team.owner_id] ?? '—')
                    : 'Unassigned'
                }
                role="Account owner"
              />
              {teamMembers
                .filter((id) => id !== team.owner_id)
                .map((id) => (
                  <TeamRow
                    key={id}
                    label={userNames[id] ?? '—'}
                    role="Team member"
                  />
                ))}
              {team.owner_id === null && teamMembers.length === 0 ? (
                <p className="rc-pad rc-muted-line">No team assigned yet.</p>
              ) : null}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function TeamRow({
  label,
  role,
}: {
  readonly label: string;
  readonly role: string;
}) {
  return (
    <div className="rc-teamrow">
      <Avatar name={label} size="sm" />
      <div>
        <div className="rc-teamrow__nm">{label}</div>
        <div className="rc-teamrow__rl">{role}</div>
      </div>
    </div>
  );
}

// ── Activity feed mapping ──
function toFeedItem(a: ActivityView): ActivityFeedItem {
  const verb =
    a.type === 'call'
      ? 'Call logged'
      : a.type === 'email_logged'
        ? 'Email logged'
        : a.type === 'note'
          ? 'Note'
          : 'Activity';
  return {
    id: a.id,
    text: (
      <span>
        <b>{verb}</b>
        {a.notes !== null && a.notes !== '' ? ` — ${a.notes}` : ''}
      </span>
    ),
    when: new Date(a.created_at).toLocaleDateString(),
  };
}

// ── Inline note logger (subject_type='contact') ──
function ContactNoteDialog({
  contactId,
  onSaved,
}: {
  readonly contactId: string;
  readonly onSaved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const submit = async () => {
    if (text.trim() === '') {
      setError('Please enter the note before saving.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createNote({
        type: 'note',
        subject_type: 'contact',
        subject_id: contactId,
        notes: text.trim(),
      });
      toast.show('Note logged.');
      setOpen(false);
      setText('');
      setSubmitting(false);
      onSaved?.();
    } catch {
      setError('The note could not be saved. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Log note
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setText('');
            setError(null);
            setSubmitting(false);
          }
        }}
        title="Log a note"
        description="A note recorded against this contact."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : 'Save note'}
            </Button>
          </>
        }
      >
        <FormField label="Note">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            disabled={submitting}
          />
        </FormField>
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      </Dialog>
    </>
  );
}
