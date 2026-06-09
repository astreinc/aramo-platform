import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Card,
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { getRequisition } from '../requisitions/requisitions-api';
import { getTalent } from '../talent/talent-api';
import type { TalentRecordView } from '../talent/types';

import { EngagementTransitionControl } from './EngagementTransitionControl';
import { EventLog } from './EventLog';
import { ResponseLogger } from './ResponseLogger';
import { ConversationLogger } from './ConversationLogger';
import {
  getEngagement,
  listEngagementEvents,
  recordConversation,
  recordResponse,
  transitionEngagement,
} from './engagement-api';
import {
  conversationErrorMessage,
  engagementDetailErrorMessage,
  responseErrorMessage,
  transitionErrorMessage,
} from './error-messages';
import { uuidv4 } from './idempotency';
import {
  ENGAGEMENT_STATE_LABELS,
  type EngagementEventView,
  type EngagementState,
  type EngagementView,
  type RecordConversationRequest,
  type RecordResponseRequest,
} from './types';

// The engagement-detail view (§2) — hosts on the sectioned pattern (header
// + sectioned panels), NOT the wizard. The header context (talent name +
// requisition title) is resolved via the §7 N+1 fetches (EngagementView is
// IDs-only). Sections: the Loops 1-5 transition control (§3), the event log
// (§4), the response + conversation loggers (§5) — each scope-gated (§8). A
// read-only actor (engagement:read, no :write) sees the state + event log
// but no controls.
//
// PR-1 (this PR) ships everything except the draft→preview→send composer
// (§6) — that is PR-2 (fast-follow), an additive section gated on
// engagement:outreach.

interface EngagementDetailViewProps {
  // Test seam mirroring TalentDetailView's sessionOverride.
  readonly sessionOverride?: Session;
}

function talentName(t: TalentRecordView): string {
  const name = `${t.first_name.trim()} ${t.last_name.trim()}`.trim();
  return name === '' ? t.id : name;
}

export function EngagementDetailView({
  sessionOverride,
}: EngagementDetailViewProps) {
  const { engagementId } = useParams<{ engagementId: string }>();
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);

  const [engagement, setEngagement] = useState<EngagementView | null>(null);
  const [events, setEvents] = useState<readonly EngagementEventView[]>([]);
  const [headerTalent, setHeaderTalent] = useState<string>('');
  const [headerReq, setHeaderReq] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    if (engagementId === undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const eng = await getEngagement(engagementId);
        if (cancelled) return;
        setEngagement(eng);
        // §7 N+1 — events feed the log + the response picker; talent +
        // requisition resolve the IDs-only header. allSettled so a context
        // failure degrades to the id rather than breaking the page.
        const [evRes, tRes, rRes] = await Promise.allSettled([
          listEngagementEvents(engagementId),
          getTalent(eng.talent_id),
          getRequisition(eng.requisition_id),
        ]);
        if (cancelled) return;
        setEvents(evRes.status === 'fulfilled' ? evRes.value.events : []);
        setHeaderTalent(
          tRes.status === 'fulfilled' ? talentName(tRes.value) : eng.talent_id,
        );
        setHeaderReq(
          rRes.status === 'fulfilled' ? rRes.value.title : eng.requisition_id,
        );
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(engagementDetailErrorMessage(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engagementId, reloadCounter]);

  // Amendment v1.1 / RULING 1 — the idempotency-key lifecycle. The keys
  // (and the client event_id) are useMemo'd keyed on the CURRENT engagement
  // state: stable across a retry of ONE operation (a network retry replays
  // safely), RE-MINTED once the state advances (the next operation from the
  // new state is genuinely new). NOT a single mint-once-per-mount registry
  // (that fits R6's fixed wizard steps, not engagement's open-ended moves).
  const currentState: EngagementState | null = engagement?.state ?? null;
  const keys = useMemo(
    () => ({
      transitionEventId: uuidv4(),
      transitionKey: uuidv4(),
      responseKey: uuidv4(),
      conversationKey: uuidv4(),
    }),
    [currentState],
  );

  const reload = () => setReloadCounter((c) => c + 1);

  if (engagementId === undefined) {
    return (
      <InlineAlert variant="error">Missing engagement id in URL.</InlineAlert>
    );
  }
  if (loading) return <p>Loading engagement…</p>;
  if (error !== null) {
    return (
      <section>
        <PageHeader title="Engagement" />
        <InlineAlert variant="error">{error}</InlineAlert>
      </section>
    );
  }
  if (engagement === null || session === null) return null;

  const canWrite = hasScope(session, 'engagement:write');
  const outreachSentEvents = events.filter(
    (e) => e.event_type === 'outreach_sent',
  );

  const handleTransition = async (to: EngagementState) => {
    try {
      await transitionEngagement(
        engagement.id,
        { to_state: to, event_id: keys.transitionEventId },
        keys.transitionKey,
      );
      reload();
    } catch (err) {
      throw new Error(transitionErrorMessage(err));
    }
  };

  const handleResponse = async (body: RecordResponseRequest) => {
    try {
      await recordResponse(engagement.id, body, keys.responseKey);
      reload();
    } catch (err) {
      throw new Error(responseErrorMessage(err));
    }
  };

  const handleConversation = async (body: RecordConversationRequest) => {
    try {
      await recordConversation(engagement.id, body, keys.conversationKey);
      reload();
    } catch (err) {
      throw new Error(conversationErrorMessage(err));
    }
  };

  return (
    <section>
      <PageHeader
        title={headerTalent}
        description={`${ENGAGEMENT_STATE_LABELS[engagement.state]} · ${headerReq}`}
      />
      <p className="engagement-detail__toolbar">
        <Link to={`/talent/${engagement.talent_id}`}>← Back to talent</Link>
      </p>

      {canWrite ? (
        <Card>
          <h2>Move engagement</h2>
          <EngagementTransitionControl
            from={engagement.state}
            onSubmit={handleTransition}
          />
        </Card>
      ) : null}

      <Card>
        <h2>Event log</h2>
        <EventLog events={events} />
      </Card>

      {canWrite ? (
        <Card>
          <h2>Record a response</h2>
          <ResponseLogger
            outreachSentEvents={outreachSentEvents}
            onSubmit={handleResponse}
          />
        </Card>
      ) : null}

      {canWrite ? (
        <Card>
          <h2>Record a conversation</h2>
          <ConversationLogger onSubmit={handleConversation} />
        </Card>
      ) : null}
    </section>
  );
}
