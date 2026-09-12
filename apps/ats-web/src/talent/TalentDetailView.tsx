import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Dialog,
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { Tabs, type TabItem } from '@aramo/fe-foundation';

import {
  Button,
  Card,
  Icons,
  StatusPill,
  bandLabel,
  type PillTone,
} from '../ui';
import { formatDate } from '../format/date';
import { formatPhone } from '../format/phone';
import { useEntityCrumb } from '../shell/breadcrumb';
import { CallButton } from '../communications/CallButton';
import { SelectionsPanel } from '../selection/SelectionsPanel';
import { TasksPanel } from '../task/TasksPanel';
import { listActivities } from '../activity/activity-api';
import { timelineErrorMessage } from '../activity/error-messages';
import type { ActivityView } from '../activity/types';
import {
  addTalentToPipeline,
  listPipelinesForTalent,
} from '../pipeline/pipeline-api';
import { PIPELINE_STATUS_LABELS, type PipelineView } from '../pipeline/types';
import { listRequisitions } from '../requisitions/requisitions-api';
import type { RequisitionView } from '../requisitions/types';
import { resolveUserNames } from '../users/users-api';
import { getTalentConsentState } from '../consent/consent-api';
import type { TalentConsentStateResponse } from '../consent/types';

import { getDossier, type DossierHead } from './dossier-api';
import { TrustPanel } from './components/TrustPanel';
import { RecordReferenceForm } from './RecordReferenceForm';
import { WorkHistoryPanel } from './WorkHistoryPanel';
import { TalentEditDrawer } from './TalentEditDrawer';
import {
  getAttachmentDownloadUrl,
  getEmailVerificationStatus,
  getTalent,
  listTalentAttachments,
  requestEmailVerification,
} from './talent-api';
import {
  attachmentsErrorMessage,
  detailErrorMessage,
} from './error-messages';
import { CONSENT_LABELS } from './talent-workspace';
import {
  AVAILABILITY_LABELS,
  WORK_AUTHORIZATION_LABELS,
  type AvailabilityStatus,
} from './stated-fields';
import type {
  AttachmentView,
  EmailSlot,
  EmailSlotVerificationStatus,
  TalentRecordView,
} from './types';

// R3 — the talent DETAIL composite, converged to the design prototype
// (`design/aramo-prototype/platform/Talent Detail.dc.html`). The LAYOUT and
// STRUCTURE match the prototype 1:1 (breadcrumb → header card with badge row,
// sub-line, contact row and action buttons → snapshot strip → tabs → 2-column
// body with a right rail). DATA is real wherever the record/API provides it
// and honest empty/"—" states otherwise — no business fact is fabricated to
// fill a prototype slot (the un-sourceable prototype content is enumerated for
// the PO in the deferred-gap discussion, not faked here).
//
// Tabs mirror the prototype (Profile / Journey / Engagement / Trust & Evidence
// / Activity); Selections and Tasks are appended because they are real
// scope-gated capabilities the prototype simply did not model — hiding them
// would be a functional regression, not a visual convergence. Every tab stays
// scope-gated: a tab the actor can't read is HIDDEN, not stubbed.
//
// Pool-open framing (R2): a talent record is from the shared tenant pool.

interface TalentDetailViewProps {
  // Test seam mirroring fe-foundation's RouteGuard.sessionStateOverride
  // pattern: pass a Session directly to exercise per-tab scope-gating
  // without mounting the real session hook.
  readonly sessionOverride?: Session;
}

function fullName(t: TalentRecordView): string {
  const first = t.first_name.trim();
  const last = t.last_name.trim();
  if (first === '' && last === '') return '—';
  return `${first} ${last}`.trim();
}

function initialsOf(t: TalentRecordView): string {
  const f = t.first_name.trim();
  const l = t.last_name.trim();
  const a = f.charAt(0);
  const b = l.charAt(0);
  const s = `${a}${b}`.toUpperCase();
  return s === '' ? '—' : s;
}

function display(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : value;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function locationOf(t: TalentRecordView): string {
  const loc = [t.city, t.state].filter((v) => v !== null && v !== '').join(', ');
  return loc === '' ? '' : loc;
}

// Display-only: default the free-text desired rate to a leading "$" when the
// recruiter didn't type a currency symbol (stored value is untouched).
function rateDisplay(value: string): string {
  const t = value.trim();
  return t === '' || t.startsWith('$') ? t : `$${t}`;
}

// A verified identity anchor manifests as one of the two top presentation
// bands on the dossier's identity dimension.
const VERIFIED_IDENTITY_BANDS = new Set(['INDEPENDENTLY_VERIFIED', 'AUTHORITATIVE']);

// The recruiting-contact posture from the real consent state (the `contacting`
// scope). granted → contactable; anything else → do-not-contact. Returns null
// when consent hasn't loaded / the scope is absent.
function contactingSummary(
  consent: TalentConsentStateResponse | null,
): 'contactable' | 'do_not_contact' | null {
  if (consent === null) return null;
  const c = consent.scopes.find((s) => s.scope === 'contacting');
  if (c === undefined) return null;
  return c.status === 'granted' ? 'contactable' : 'do_not_contact';
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// "In database since Jan 2024" — the month/year of the record's creation, UTC.
function monthYear(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Caller-owned tone maps — a BAND/LABEL, never a numeric value.
const AVAILABILITY_TONE: Record<AvailabilityStatus, PillTone> = {
  available_now: 'ok',
  open_to_offers: 'info',
  not_looking: 'neutral',
  unknown: 'neutral',
};
const CONSENT_TONE: Record<string, PillTone> = {
  contactable: 'ok',
  expiring_lt_30d: 'warn',
  do_not_contact: 'danger',
};

export function TalentDetailView({ sessionOverride }: TalentDetailViewProps) {
  const { talentId } = useParams<{ talentId: string }>();
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scopes: readonly string[] = Array.isArray(session?.scopes)
    ? (session as Session).scopes
    : [];

  const [talent, setTalent] = useState<TalentRecordView | null>(null);
  // T10-B1/F-006 — publish the talent name as the breadcrumb entity.
  useEntityCrumb(talent !== null ? fullName(talent) : null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // View-level enrichment for the header/snapshot/rail (each best-effort — a
  // failure never blocks the surface, it falls back to an honest empty state).
  const [pipelines, setPipelines] = useState<readonly PipelineView[] | null>(null);
  const [ownerName, setOwnerName] = useState<string | null>(null);
  // Real-data sources for the header badges + Consent rail (best-effort — a
  // failure/403 leaves the badge/row absent, never faked).
  const [dossier, setDossier] = useState<DossierHead | null>(null);
  const [consent, setConsent] = useState<TalentConsentStateResponse | null>(null);
  const [emailVerif, setEmailVerif] = useState<
    Record<EmailSlot, EmailSlotVerificationStatus>
  >({ email1: 'none', email2: 'none' });
  const [verifySent, setVerifySent] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    if (talentId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getTalent(talentId)
      .then((res) => {
        if (cancelled) return;
        setTalent(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(detailErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  // Pipelines feed the "Opportunities" snapshot tile AND the Journey tab —
  // fetched once here (pipeline:read gated) and shared.
  useEffect(() => {
    if (talentId === undefined || !scopes.includes('pipeline:read')) return;
    let cancelled = false;
    listPipelinesForTalent(talentId)
      .then((res) => {
        if (!cancelled) setPipelines(res.items);
      })
      .catch(() => {
        if (!cancelled) setPipelines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [talentId, scopes]);

  // Owner display name for the Ownership rail (best-effort directory resolve).
  useEffect(() => {
    const ownerId = talent?.owner_id ?? null;
    if (ownerId === null || ownerId === '') return;
    let cancelled = false;
    resolveUserNames([ownerId])
      .then((map) => {
        if (!cancelled) setOwnerName(map[ownerId] ?? null);
      })
      .catch(() => {
        /* best-effort — falls back to "—" */
      });
    return () => {
      cancelled = true;
    };
  }, [talent?.owner_id]);

  // Trust dossier — powers the "Verified identity" + "Evidence supported · N
  // review" badges and the rail's "Identity resolution" row. Best-effort.
  useEffect(() => {
    if (talentId === undefined) return;
    let cancelled = false;
    getDossier(talentId)
      .then((d) => {
        if (!cancelled) setDossier(d);
      })
      .catch(() => {
        /* best-effort — badges/row absent on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  // Consent state — powers the "Contact permitted" badge + the rail's consent
  // rows (reliable per-talent, unlike the list-only consent_summary). Best-effort.
  useEffect(() => {
    if (talentId === undefined) return;
    let cancelled = false;
    getTalentConsentState(talentId)
      .then((c) => {
        if (!cancelled) setConsent(c);
      })
      .catch(() => {
        /* best-effort — rows fall back to "—" */
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  // Email-verification status — drives the "Verified identity" badge (with the
  // dossier) and the header "Verify identity" action. TR-3 B2. Best-effort.
  useEffect(() => {
    if (talentId === undefined) return;
    let cancelled = false;
    getEmailVerificationStatus(talentId)
      .then((res) => {
        if (cancelled) return;
        const next: Record<EmailSlot, EmailSlotVerificationStatus> = {
          email1: 'none',
          email2: 'none',
        };
        for (const item of res.items ?? []) next[item.slot] = item.status;
        setEmailVerif(next);
      })
      .catch(() => {
        /* best-effort — badge/action fall back to unverified */
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  if (talentId === undefined) {
    return <InlineAlert variant="error">Missing talent id in URL.</InlineAlert>;
  }
  if (loading) return <p>Loading talent…</p>;
  if (error !== null) {
    return (
      <section>
        <div className="talent-detail__crumb">
          <Link to="/talent">Talent</Link>
        </div>
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/talent">← Back to talent</Link>
        </p>
      </section>
    );
  }
  if (talent === null || session === null) return null;

  const canEdit = hasScope(session, 'talent:edit');
  const activePipelines = (pipelines ?? []).filter(
    (p) => p.status !== 'completed' && p.status !== 'not_in_consideration',
  );

  // Identity verification — the header action (prototype: verification is a
  // deliberate action, not inline noise next to the email). Shown when the
  // primary email exists and isn't verified yet, and the actor can edit.
  const emailVerified =
    emailVerif.email1 === 'verified' || emailVerif.email2 === 'verified';
  const canVerifyIdentity =
    canEdit && (talent.email1 ?? '') !== '' && emailVerif.email1 !== 'verified';
  const verifyPending = verifySent || emailVerif.email1 === 'pending';
  const onVerifyIdentity = () => {
    requestEmailVerification(talent.id, 'email1')
      .then(() => {
        setEmailVerif((prev) => ({ ...prev, email1: 'pending' }));
        setVerifySent(true);
      })
      .catch(() => {
        /* best-effort — the button stays actionable on failure */
      });
  };

  const tabs: TabItem[] = [
    {
      id: 'profile',
      label: 'Profile',
      content: (
        <ProfileTab talent={talent} canReadDocuments={scopes.includes('attachment:read')} />
      ),
    },
  ];
  if (scopes.includes('pipeline:read')) {
    tabs.push({
      id: 'journey',
      label: 'Journey',
      content: (
        <JourneyTab
          pipelines={pipelines}
          canStartSubmittal={scopes.includes('submittal:create')}
          talentId={talent.id}
        />
      ),
    });
  }
  tabs.push({
    id: 'engagement',
    label: 'Engagement',
    content: <EngagementTab talent={talent} session={session} ownerName={ownerName} />,
  });
  if (scopes.includes('talent:read')) {
    tabs.push({
      id: 'trust',
      label: 'Trust & Evidence',
      content: (
        <>
          <WorkHistoryPanel talentId={talent.id} />
          <TrustPanel talentId={talent.id} canResolve={scopes.includes('identity:resolve')} />
          {canEdit && <RecordReferenceForm recordId={talent.id} />}
        </>
      ),
    });
  }
  if (scopes.includes('activity:read')) {
    tabs.push({
      id: 'activity',
      label: 'Activity',
      content: <ActivityPanel talentId={talent.id} />,
    });
  }
  // Capability tabs the prototype does not model — appended, never dropped.
  if (scopes.includes('selection:read')) {
    tabs.push({
      id: 'selections',
      label: 'Selections',
      // Wrapped in the shared card chrome so the tab reads consistently with
      // Profile / Journey / Engagement (the panel itself is design-neutral).
      content: (
        <Card>
          <SelectionsPanel talentId={talent.id} />
        </Card>
      ),
    });
  }
  if (scopes.includes('task:read')) {
    tabs.push({
      id: 'tasks',
      label: 'Tasks',
      content: (
        <Card>
          <TasksPanel
            ownerType="talent_record"
            ownerId={talent.id}
            canWrite={scopes.includes('task:write')}
          />
        </Card>
      ),
    });
  }

  // Prototype sub-line: title · location. Title (B1) leads; falls back to the
  // current employer when the record has no title yet.
  const headline = talent.title ?? talent.current_employer;
  const subParts = [headline, locationOf(talent)].filter(
    (v): v is string => v !== null && v !== '',
  );

  return (
    <section className="talent-detail">
      <div className="talent-detail__crumb" data-testid="talent-detail-crumb">
        <Link to="/talent">Talent</Link>
        <span className="talent-detail__crumb-sep">/</span>
        {fullName(talent)}
      </div>

      <header className="talent-detail__head" data-testid="talent-detail-head">
        <span className="talent-detail__avatar" aria-hidden="true">
          {initialsOf(talent)}
        </span>
        <div className="talent-detail__head-main">
          {/* Single page H1 (enterprise one-H1 rule). */}
          <div className="talent-detail__idrow">
            <h1 className="talent-detail__name">{fullName(talent)}</h1>
            <HeaderBadges
              talent={talent}
              dossier={dossier}
              consent={consent}
              emailVerified={emailVerified}
            />
          </div>
          {/* One sub-line (prototype: title · location · …). Falls back to the
              pool-open framing (R2) only when the record has no employer/location. */}
          <div className="talent-detail__subline">
            {subParts.length > 0 ? subParts.join(' · ') : 'From your tenant talent pool.'}
          </div>
          <HeaderContact talent={talent} />
        </div>
        <div className="talent-detail__actions">
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
            Add to requisition
          </Button>
          {canVerifyIdentity ? (
            <button
              type="button"
              className="tc-button tc-button--sm talent-detail__verify"
              data-testid="verify-email-btn-email1"
              disabled={verifyPending}
              onClick={onVerifyIdentity}
              title="Send an identity-verification email to the talent's primary address."
            >
              <Icons.IconAlert />
              {verifyPending ? 'Verification sent' : 'Verify identity'}
            </button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled
            title="Activity logging isn't available on this screen yet."
          >
            Log activity
          </Button>
          {canEdit ? (
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
              Edit profile
            </Button>
          ) : (
            <Button variant="secondary" size="sm" disabled title="Editing needs talent:edit.">
              Edit profile
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled title="More actions coming soon.">
            ⋯
          </Button>
        </div>
      </header>

      <SnapshotStrip
        talent={talent}
        opportunities={pipelines === null ? null : activePipelines.length}
      />

      <div className="talent-detail__body">
        <div className="talent-detail__main">
          <Tabs items={tabs} ariaLabel="Talent details" />
        </div>
        <aside className="talent-detail__rail" data-testid="talent-detail-rail">
          <YourAttentionCard />
          <ConsentCard talent={talent} dossier={dossier} consent={consent} />
          <OwnershipCard talent={talent} ownerName={ownerName} />
        </aside>
      </div>

      <AddToRequisitionDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        talentId={talent.id}
      />

      {editOpen ? (
        <TalentEditDrawer
          talent={talent}
          onClose={() => setEditOpen(false)}
          onSaved={(updated) => {
            setTalent(updated);
            setEditOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}

// The header badge row, prototype order: Verified identity · Contact permitted
// · Actively looking · [Recruiting ready — backend gap, omitted] · Evidence
// supported · N review. Every badge is real-data-derived:
//   • Verified identity — dossier identity dimension band (verified anchor),
//     with the email-verification read as a fallback signal.
//   • Contact permitted — the real consent `contacting` scope (falls back to
//     the list-only consent_summary if present).
//   • Actively looking — talent-stated availability_status (on the record).
//   • Evidence supported · N — the dossier ledger; N = open contradiction count
//     (a count of review ITEMS, never a number/grade, R10).
function HeaderBadges({
  talent,
  dossier,
  consent,
  emailVerified,
}: {
  talent: TalentRecordView;
  dossier: DossierHead | null;
  consent: TalentConsentStateResponse | null;
  emailVerified: boolean;
}) {
  const identityBand = dossier?.dimensions?.identity?.band ?? null;
  const verifiedIdentity =
    (identityBand !== null && VERIFIED_IDENTITY_BANDS.has(identityBand)) || emailVerified;

  const contacting = contactingSummary(consent) ?? talent.consent_summary ?? null;

  const ledgerEstablished = dossier?.ledger_established === true;
  const reviewCount = dossier?.contradictions?.length ?? 0;

  return (
    <span className="talent-detail__badges">
      {verifiedIdentity ? (
        <StatusPill tone="ok" dot>Verified identity</StatusPill>
      ) : null}
      {contacting != null ? (
        <StatusPill tone={CONSENT_TONE[contacting] ?? 'neutral'} dot>
          {contacting === 'contactable'
            ? 'Contact permitted'
            : (CONSENT_LABELS[contacting] ?? contacting)}
        </StatusPill>
      ) : null}
      {talent.availability_status !== null ? (
        <StatusPill tone={AVAILABILITY_TONE[talent.availability_status]} dot>
          {AVAILABILITY_LABELS[talent.availability_status]}
        </StatusPill>
      ) : null}
      {talent.recruiting_ready === true ? (
        <StatusPill tone="info" dot>Recruiting ready</StatusPill>
      ) : null}
      {ledgerEstablished ? (
        <StatusPill tone="warn" dot>
          {reviewCount > 0
            ? `Evidence supported · ${reviewCount} review`
            : 'Evidence supported'}
        </StatusPill>
      ) : null}
      {talent.is_hot ? <StatusPill tone="hot" dot>Hot</StatusPill> : null}
    </span>
  );
}

// The header contact row (prototype: email · phone · work authorization ·
// desired rate). Purely presentational — clean, no inline verification noise.
// Verification is a deliberate header action ("Verify identity"), and the
// verified state reads as the name-row "Verified identity" badge.
function HeaderContact({ talent }: { talent: TalentRecordView }) {
  const phone = talent.phone_cell ?? talent.phone_home ?? talent.phone_work;
  const emails = [talent.email1, talent.email2].filter(
    (v): v is string => v !== null && v !== '',
  );

  return (
    <div className="talent-detail__contact">
      {emails.map((value) => (
        <span key={value} className="talent-detail__contact-item">
          <Icons.IconMail />
          {value}
        </span>
      ))}
      {phone !== null && phone !== '' ? (
        <span className="talent-detail__contact-item">
          <PhoneGlyph />
          {formatPhone(phone)}
        </span>
      ) : null}
      {talent.work_authorization !== null ? (
        <span className="talent-detail__contact-item">
          <Icons.IconShield />
          {WORK_AUTHORIZATION_LABELS[talent.work_authorization]}
        </span>
      ) : null}
      {talent.desired_pay !== null && talent.desired_pay !== '' ? (
        <span className="talent-detail__contact-item talent-detail__mono">
          {rateDisplay(talent.desired_pay)} desired
        </span>
      ) : null}
    </div>
  );
}

// Phone glyph — matches the prototype's inline SVG (fe-foundation has no phone
// icon). Stroke follows the contact-row muted colour via currentColor.
function PhoneGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </svg>
  );
}

// The at-a-glance snapshot strip. LAST CONTACT and OPPORTUNITIES are real
// (last_activity_at enrichment; active-pipeline count). The remaining tiles
// (Submittals / Interviews / Offers / Assignments) have no talent-scoped
// aggregate endpoint — shown as "—" and enumerated as deferred gaps, never a
// fabricated count. (The prototype's second tile is relabelled "Submittals" —
// the canonical term; the Tier-2 vocabulary gate forbids the prototype's word.)
function SnapshotStrip({
  talent,
  opportunities,
}: {
  talent: TalentRecordView;
  opportunities: number | null;
}) {
  const tiles: { label: string; value: string }[] = [
    { label: 'Opportunities', value: opportunities === null ? '—' : `${opportunities} active` },
    { label: 'Submittals', value: '—' },
    { label: 'Interviews', value: '—' },
    { label: 'Offers', value: '—' },
    { label: 'Assignments', value: '—' },
    { label: 'Last contact', value: formatDate(talent.last_activity_at) || '—' },
  ];
  return (
    <div className="talent-detail__snapshot" data-testid="talent-snapshot">
      {tiles.map((t) => (
        <div key={t.label} className="talent-detail__snap">
          <div className="talent-detail__snap-k">{t.label}</div>
          <div className="talent-detail__snap-v">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

// PROFILE tab — Skills, Work history, Documents (prototype card order).
function ProfileTab({
  talent,
  canReadDocuments,
}: {
  talent: TalentRecordView;
  canReadDocuments: boolean;
}) {
  const skills = (talent.key_skills ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  return (
    <>
      <Card>
        <div className="talent-detail__ctitle">Skills</div>
        {skills.length > 0 ? (
          <>
            <div className="talent-detail__skills">
              {skills.map((s) => (
                <span key={s} className="talent-detail__skill">{s}</span>
              ))}
            </div>
            <div className="talent-detail__note">
              ✓ = evidence-backed from work history or assessment — not
              self-reported alone.
            </div>
          </>
        ) : (
          <p className="talent-detail__empty">No skills recorded yet.</p>
        )}
      </Card>

      <Card>
        <div className="talent-detail__ctitle">Work history</div>
        <p className="talent-detail__empty">
          No structured work history yet. Resume-derived history capture is
          coming soon.
        </p>
      </Card>

      {canReadDocuments ? <DocumentsCard talentId={talent.id} /> : null}
    </>
  );
}

function DocumentsCard({ talentId }: { talentId: string }) {
  const [items, setItems] = useState<readonly AttachmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTalentAttachments(talentId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(attachmentsErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  const [preview, setPreview] = useState<{
    name: string;
    url: string;
    mime: string | null;
  } | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  // B6 — inline preview: mint a fresh short-lived presigned GET and show it in
  // an embedded frame (PDF / images render natively; other types fall back to
  // open/download since browsers can't render them inline). URLs are per-click,
  // never stored. A failure is surfaced (not silently swallowed) so the
  // recruiter sees why nothing opened.
  const previewDoc = (a: AttachmentView) => {
    setDocError(null);
    getAttachmentDownloadUrl(a.id)
      .then((res) => {
        setPreview({ name: a.file_name, url: res.presigned_url, mime: a.mime });
      })
      .catch(() => {
        setDocError('We couldn’t open this document. Please try again.');
      });
  };
  const downloadDoc = (id: string) => {
    setDocError(null);
    getAttachmentDownloadUrl(id)
      .then((res) => {
        window.open(res.presigned_url, '_blank', 'noopener,noreferrer');
      })
      .catch(() => {
        setDocError('We couldn’t open this document. Please try again.');
      });
  };

  return (
    <Card>
      <div className="talent-detail__card-head">
        <span className="talent-detail__ctitle">Documents</span>
      </div>
      {loading ? (
        <p>Loading attachments…</p>
      ) : error !== null ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : items.length === 0 ? (
        <p className="talent-detail__empty">
          No attachments for this talent record yet.
        </p>
      ) : (
        <>
          <ul className="talent-detail__docs">
            {items.map((a) => (
              <li key={a.id} className="talent-detail__doc">
                <span className="talent-detail__doc-name">
                  <button
                    type="button"
                    className="talent-detail__doc-link"
                    onClick={() => previewDoc(a)}
                  >
                    {a.file_name}
                  </button>
                  <span className="talent-detail__doc-meta">
                    {a.is_resume ? 'Resume · ' : ''}
                    {bytes(a.size_bytes)}
                    {a.mime !== null ? ` · ${a.mime}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="talent-detail__doc-dl"
                  onClick={() => previewDoc(a)}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className="talent-detail__doc-dl"
                  onClick={() => downloadDoc(a.id)}
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
          {docError !== null ? (
            <div style={{ marginTop: 10 }}>
              <InlineAlert variant="error">{docError}</InlineAlert>
            </div>
          ) : null}
          {preview !== null ? (
            <div className="talent-detail__doc-preview">
              <div className="talent-detail__doc-preview-head">
                <span className="talent-detail__doc-preview-name">{preview.name}</span>
                <button
                  type="button"
                  className="talent-detail__doc-dl"
                  onClick={() => setPreview(null)}
                >
                  Close
                </button>
              </div>
              {isPreviewableMime(preview.mime) ? (
                <iframe
                  title={`Preview of ${preview.name}`}
                  src={preview.url}
                  className="talent-detail__doc-frame"
                />
              ) : (
                <p className="talent-detail__empty">
                  Inline preview isn't available for this file type
                  {preview.mime !== null ? ` (${preview.mime})` : ''}.{' '}
                  <button
                    type="button"
                    className="talent-detail__doc-link"
                    onClick={() =>
                      window.open(preview.url, '_blank', 'noopener,noreferrer')
                    }
                  >
                    Open in a new tab
                  </button>
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

// Browsers render PDFs and images inline; everything else (e.g. .docx) can't be
// previewed natively and falls back to open/download.
function isPreviewableMime(mime: string | null): boolean {
  return mime === 'application/pdf' || (mime !== null && mime.startsWith('image/'));
}

// JOURNEY tab — the talent's pipelines across requisitions, styled as the
// prototype's journey cards. Per-pipeline lifecycle STEPS (Sourced/Qualified/
// Submitted/…) come from the journey composition endpoint and are a deferred
// gap here; the card shows the real requisition + current recruiting state.
function JourneyTab({
  pipelines,
  canStartSubmittal,
  talentId,
}: {
  pipelines: readonly PipelineView[] | null;
  canStartSubmittal: boolean;
  talentId: string;
}) {
  if (pipelines === null) return <p>Loading journey…</p>;
  if (pipelines.length === 0) {
    return (
      <Card>
        <div className="talent-detail__ctitle">Journey</div>
        <p className="talent-detail__empty">
          This talent record is not on any pipeline yet.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <div className="talent-detail__ctitle">Journey</div>
      <div className="talent-detail__note" style={{ marginTop: 0, marginBottom: 14 }}>
        Each row summarizes its owning lifecycle — click through to act.
      </div>
      {pipelines.map((p) => (
        <div key={p.id} className="talent-detail__jcard">
          <div className="talent-detail__jhead">
            <Link to={`/requisitions/${p.requisition_id}`}>
              Requisition {p.requisition_id}
            </Link>
            <StatusPill tone="info" dot>{PIPELINE_STATUS_LABELS[p.status]}</StatusPill>
          </div>
          {canStartSubmittal ? (
            <div className="talent-detail__jnext">
              <Link to={`/talent/${talentId}/submittal/${p.requisition_id}`}>
                Submittal
              </Link>
            </div>
          ) : null}
        </div>
      ))}
    </Card>
  );
}

// ENGAGEMENT tab — Relationship + Communications (prototype structure).
// Relationship surfaces the real owner + last-contact; STATE and NEXT
// FOLLOW-UP are not modelled fields (shown "—"). Call is the real COMM-V1
// action; Email/Teams need a requisition context (unavailable on this
// standalone surface) so they stay disabled. Communication history has no
// talent-scoped read here — honest empty state.
function EngagementTab({
  talent,
  session,
  ownerName,
}: {
  talent: TalentRecordView;
  session: Session;
  ownerName: string | null;
}) {
  return (
    <>
      <Card>
        <div className="talent-detail__ctitle">Relationship</div>
        <div className="talent-detail__rel">
          <div>
            <div className="talent-detail__rel-k">STATE</div>
            <div className="talent-detail__rel-v">—</div>
          </div>
          <div>
            <div className="talent-detail__rel-k">LAST CONTACT</div>
            <div className="talent-detail__rel-v">
              {formatDate(talent.last_activity_at) || '—'}
            </div>
          </div>
          <div>
            <div className="talent-detail__rel-k">NEXT FOLLOW-UP</div>
            <div className="talent-detail__rel-v">—</div>
          </div>
          <div>
            <div className="talent-detail__rel-k">OWNER</div>
            <div className="talent-detail__rel-v">{ownerName ?? '—'}</div>
          </div>
        </div>
        <div className="talent-detail__rel-actions">
          <CallButton talent={talent} session={session} />
          <Button
            variant="secondary"
            size="sm"
            disabled
            title="Email needs a requisition context — open the talent inside a requisition to email."
          >
            Email
          </Button>
          <Button variant="secondary" size="sm" disabled title="Coming soon.">
            Log activity
          </Button>
          <Button variant="secondary" size="sm" disabled title="Coming soon.">
            Create follow-up
          </Button>
          <span className="talent-detail__rel-note">
            Actions respect consent — outcomes never mutate consent.
          </span>
        </div>
      </Card>
      <Card>
        <div className="talent-detail__ctitle">Communications</div>
        <div className="talent-detail__note" style={{ marginTop: 0 }}>
          Human interaction history. Dispositions are interaction outcomes —
          they never mutate consent.
        </div>
        <p className="talent-detail__empty">
          No communication history recorded on this record yet.
        </p>
      </Card>
    </>
  );
}

function ActivityPanel({ talentId }: { talentId: string }) {
  const [items, setItems] = useState<readonly ActivityView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listActivities('talent_record', talentId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(timelineErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  return (
    <Card>
      <div className="talent-detail__ctitle">Activity — one timeline, every lifecycle</div>
      {loading ? (
        <p>Loading activity…</p>
      ) : error !== null ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : items.length === 0 ? (
        <p className="talent-detail__empty">No activity for this talent record yet.</p>
      ) : (
        <ul className="talent-detail__timeline">
          {items.map((a) => (
            <li key={a.id} className="talent-detail__timeline-item">
              <p>{a.notes ?? a.type}</p>
              <time dateTime={a.created_at}>{formatDate(a.created_at)}</time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Right rail ──────────────────────────────────────────────────────────────

// "Your attention" — the prototype's action-item card. There is no
// per-talent action-aggregation endpoint, so this is an honest empty state
// (deferred gap), never fabricated interview/follow-up items.
function YourAttentionCard() {
  return (
    <Card>
      <div className="talent-detail__rail-title">Your attention</div>
      <p className="talent-detail__empty">Nothing needs your attention right now.</p>
    </Card>
  );
}

// "Consent & contactability" — driven by the REAL consent state (per-scope
// status + granted date) and the dossier's identity dimension. Channel-level
// (Email/SMS) consent is not modelled in the scope set, so those rows are
// intentionally not shown (a scope-level model, not per-channel). "Future
// rediscovery" maps to the `matching` scope. "Identity resolution" shows the
// identity dimension band (a named state — never a number).
function ConsentCard({
  talent,
  dossier,
  consent,
}: {
  talent: TalentRecordView;
  dossier: DossierHead | null;
  consent: TalentConsentStateResponse | null;
}) {
  const scopeStatus = (name: string): string | null =>
    consent?.scopes.find((s) => s.scope === name)?.status ?? null;

  const contacting = contactingSummary(consent) ?? talent.consent_summary ?? null;
  const recruiting =
    contacting === 'contactable'
      ? { label: 'Permitted', tone: 'ok' as const }
      : contacting === 'expiring_lt_30d'
        ? { label: 'Expiring < 30d', tone: 'warn' as const }
        : contacting === 'do_not_contact'
          ? { label: 'Not permitted', tone: 'danger' as const }
          : null;

  const matching = scopeStatus('matching');
  const rediscovery =
    matching === null
      ? null
      : matching === 'granted'
        ? { label: 'Permitted', tone: 'ok' as const }
        : { label: 'Not permitted', tone: 'danger' as const };

  const grantedAt =
    consent?.scopes.find((s) => s.scope === 'contacting')?.granted_at ?? null;
  const identityBand = dossier?.dimensions?.identity?.band ?? null;

  return (
    <Card>
      <div className="talent-detail__rail-title">Consent &amp; contactability</div>
      <div className="talent-detail__kvs">
        <span className="talent-detail__kv">
          <span>Recruiting contact</span>
          {recruiting !== null ? (
            <b className={`talent-detail__kv-${recruiting.tone}`}>{recruiting.label}</b>
          ) : (
            <span>—</span>
          )}
        </span>
        <span className="talent-detail__kv">
          <span>Future rediscovery</span>
          {rediscovery !== null ? (
            <b className={`talent-detail__kv-${rediscovery.tone}`}>{rediscovery.label}</b>
          ) : (
            <span>—</span>
          )}
        </span>
        <span className="talent-detail__kv">
          <span>Granted</span>
          <span>{formatDate(grantedAt) || '—'}</span>
        </span>
        <span className="talent-detail__kv">
          <span>Identity resolution</span>
          <span>{identityBand !== null ? bandLabel(identityBand) : '—'}</span>
        </span>
      </div>
    </Card>
  );
}

// "Ownership" — Owner (resolved display name), Source and In-database-since are
// real record fields; Team is not modelled ("—").
function OwnershipCard({
  talent,
  ownerName,
}: {
  talent: TalentRecordView;
  ownerName: string | null;
}) {
  return (
    <Card>
      <div className="talent-detail__rail-title">Ownership</div>
      <div className="talent-detail__kvs">
        <span className="talent-detail__kv">
          <span>Owner</span>
          <b className="talent-detail__kv-strong">
            {ownerName ?? (talent.owner_id !== null ? '—' : 'Unassigned')}
          </b>
        </span>
        <span className="talent-detail__kv">
          <span>Team</span>
          <span>—</span>
        </span>
        <span className="talent-detail__kv">
          <span>Source</span>
          <span>{display(talent.source)}</span>
        </span>
        <span className="talent-detail__kv">
          <span>In database since</span>
          <span>{monthYear(talent.created_at)}</span>
        </span>
      </div>
    </Card>
  );
}

// Add-to-requisition — the header's primary CTA. Lists the tenant's OPEN
// requisitions and creates a pipeline (POST /v1/pipelines) for the chosen one.
function AddToRequisitionDialog({
  open,
  onClose,
  talentId,
}: {
  open: boolean;
  onClose: () => void;
  talentId: string;
}) {
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [reqId, setReqId] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(false);
    setAdded(false);
    setActionErr(null);
    setReqId('');
    listRequisitions()
      .then((r) => {
        if (cancelled) return;
        setReqs(r.items.filter((x) => x.status === 'open'));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadErr(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onAdd = () => {
    if (reqId === '') return;
    setBusy(true);
    setActionErr(null);
    addTalentToPipeline(talentId, reqId)
      .then(() => {
        setBusy(false);
        setAdded(true);
      })
      .catch((err: unknown) => {
        setBusy(false);
        const status = (err as { status?: number } | null)?.status;
        // Already on this pipeline — treat as success (idempotent intent).
        if (status === 409 || status === 422) {
          setAdded(true);
          return;
        }
        setActionErr('We couldn’t add this talent to the requisition. Please try again.');
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to requisition"
    >
      {loading ? (
        <p>Loading requisitions…</p>
      ) : loadErr ? (
        <InlineAlert variant="error">Could not load requisitions.</InlineAlert>
      ) : added ? (
        <>
          <InlineAlert variant="success">Talent added to the requisition.</InlineAlert>
          <div className="talent-detail__dialog-actions">
            <Button variant="secondary" onClick={onClose}>Done</Button>
          </div>
        </>
      ) : reqs.length === 0 ? (
        <p className="talent-detail__empty">No open requisitions to add to.</p>
      ) : (
        <>
          <label className="talent-detail__dialog-field">
            <span>Requisition</span>
            <select
              value={reqId}
              onChange={(e) => setReqId(e.target.value)}
              aria-label="Requisition"
            >
              <option value="">Choose a requisition…</option>
              {reqs.map((r) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </select>
          </label>
          {actionErr !== null ? (
            <InlineAlert variant="error">{actionErr}</InlineAlert>
          ) : null}
          <div className="talent-detail__dialog-actions">
            <Button variant="primary" onClick={onAdd} disabled={reqId === '' || busy}>
              {busy ? 'Adding…' : 'Add to requisition'}
            </Button>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
