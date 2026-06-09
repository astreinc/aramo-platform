import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Card,
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { Tabs, type TabItem } from '../components/Tabs';
import { EngagementsPanel } from '../engagement/EngagementsPanel';
import { listActivities } from '../activity/activity-api';
import { timelineErrorMessage } from '../activity/error-messages';
import type { ActivityView } from '../activity/types';
import { listPipelinesForTalent } from '../pipeline/pipeline-api';
import {
  PIPELINE_STATUS_LABELS,
  type PipelineView,
} from '../pipeline/types';

import { getTalent, listTalentAttachments } from './talent-api';
import {
  attachmentsErrorMessage,
  detailErrorMessage,
  pipelinesErrorMessage,
} from './error-messages';
import type { AttachmentView, TalentRecordView } from './types';

// R3 — the talent DETAIL composite. Tabs: Identity / Attachments /
// Activity / Pipelines. Per-tab scope-gating: the Identity tab uses the
// base scope (talent:read) and is always present when the route renders;
// the other three tabs are added only when their per-feature scope is
// granted. A tab the actor can't read is HIDDEN, not stubbed.
//
// Pool-open framing (R2): a talent record is from the shared tenant pool
// — the page description reflects that, NOT "owned by you".

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

function display(value: string | null): string {
  return value === null || value === '' ? '—' : value;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function TalentDetailView({ sessionOverride }: TalentDetailViewProps) {
  const { talentId } = useParams<{ talentId: string }>();
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);

  const [talent, setTalent] = useState<TalentRecordView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (talentId === undefined) {
    return <InlineAlert variant="error">Missing talent id in URL.</InlineAlert>;
  }
  if (loading) return <p>Loading talent…</p>;
  if (error !== null) {
    return (
      <section>
        <PageHeader title="Talent" />
        <InlineAlert variant="error">{error}</InlineAlert>
        <p>
          <Link to="/talent">← Back to talent</Link>
        </p>
      </section>
    );
  }
  if (talent === null || session === null) return null;

  const scopes = session.scopes;
  const tabs: TabItem[] = [
    {
      id: 'identity',
      label: 'Identity',
      content: <IdentityPanel talent={talent} />,
    },
  ];
  if (scopes.includes('attachment:read')) {
    tabs.push({
      id: 'attachments',
      label: 'Attachments',
      content: <AttachmentsPanel talentId={talent.id} />,
    });
  }
  if (scopes.includes('activity:read')) {
    tabs.push({
      id: 'activity',
      label: 'Activity',
      content: <ActivityPanel talentId={talent.id} />,
    });
  }
  if (scopes.includes('pipeline:read')) {
    tabs.push({
      id: 'pipelines',
      label: 'Pipelines',
      content: (
        <PipelinesPanel
          talentId={talent.id}
          canStartSubmittal={scopes.includes('submittal:create')}
        />
      ),
    });
  }
  if (scopes.includes('engagement:read')) {
    tabs.push({
      id: 'engagements',
      label: 'Engagements',
      content: <EngagementsPanel talentId={talent.id} />,
    });
  }

  const canEdit =
    Array.isArray(session.scopes) && hasScope(session, 'talent:edit');

  return (
    <section>
      <PageHeader
        title={fullName(talent)}
        description="From your tenant talent pool."
      />
      <p className="talent-detail__toolbar">
        <Link to="/talent">← Back to talent</Link>
        {canEdit ? (
          <>
            {' · '}
            <Link to={`/talent/${talent.id}/edit`} className="talent-detail__edit-link">
              Edit
            </Link>
          </>
        ) : null}
      </p>
      <Tabs items={tabs} ariaLabel="Talent details" />
    </section>
  );
}

function IdentityPanel({ talent }: { talent: TalentRecordView }) {
  return (
    <Card>
      <dl className="detail__meta">
        <div>
          <dt>Email</dt>
          <dd>{display(talent.email1)}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>
            {display(talent.phone_cell ?? talent.phone_home ?? talent.phone_work)}
          </dd>
        </div>
        <div>
          <dt>Current employer</dt>
          <dd>{display(talent.current_employer)}</dd>
        </div>
        <div>
          <dt>Key skills</dt>
          <dd>{display(talent.key_skills)}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>
            {display(
              [talent.city, talent.state].filter((v) => v !== null && v !== '').join(', ') ||
                null,
            )}
          </dd>
        </div>
        <div>
          <dt>Hot</dt>
          <dd>{talent.is_hot ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Can relocate</dt>
          <dd>{talent.can_relocate ? 'Yes' : 'No'}</dd>
        </div>
        {talent.notes !== null && talent.notes !== '' ? (
          <div>
            <dt>Notes</dt>
            <dd>{talent.notes}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

function AttachmentsPanel({ talentId }: { talentId: string }) {
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

  if (loading) return <p>Loading attachments…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  if (items.length === 0) {
    return <p>No attachments for this talent record yet.</p>;
  }
  return (
    <ul className="detail__list">
      {items.map((a) => (
        <li key={a.id}>
          <strong>{a.file_name}</strong>
          {a.is_resume ? ' · résumé' : ''} · {bytes(a.size_bytes)}
          {a.mime !== null ? ` · ${a.mime}` : ''}
        </li>
      ))}
    </ul>
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

  if (loading) return <p>Loading activity…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  if (items.length === 0) {
    return <p>No activity for this talent record yet.</p>;
  }
  return (
    <ul className="timeline">
      {items.map((a) => (
        <li key={a.id} className="timeline__item">
          <Card>
            <p>{a.notes ?? a.type}</p>
            <time dateTime={a.created_at}>{a.created_at}</time>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function PipelinesPanel({
  talentId,
  canStartSubmittal,
}: {
  talentId: string;
  canStartSubmittal: boolean;
}) {
  const [items, setItems] = useState<readonly PipelineView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPipelinesForTalent(talentId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(pipelinesErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  if (loading) return <p>Loading pipelines…</p>;
  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  if (items.length === 0) {
    return <p>This talent record is not on any pipeline yet.</p>;
  }
  return (
    <ul className="detail__list">
      {items.map((p) => (
        <li key={p.id}>
          <Link to={`/requisitions/${p.requisition_id}`}>
            Requisition {p.requisition_id}
          </Link>{' '}
          — {PIPELINE_STATUS_LABELS[p.status]}
          {canStartSubmittal && (
            <>
              {' · '}
              <Link to={`/talent/${talentId}/submittal/${p.requisition_id}`}>
                Submittal
              </Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
