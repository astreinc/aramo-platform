import {
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { getRequisition } from '../requisitions/requisitions-api';
import { getTalent } from '../talent/talent-api';
import type { TalentRecordView } from '../talent/types';
import {
  Avatar,
  Card,
  CardHead,
  Stepper,
  StatusPill,
  type PillTone,
} from '../ui';

import { EngagementTransitionControl } from './EngagementTransitionControl';
import { EventLog } from './EventLog';
import { OutreachComposer } from './OutreachComposer';
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
  type OutreachSentPayload,
  type RecordConversationRequest,
  type RecordResponseRequest,
} from './types';

// Engagement composer (2F) — re-skinned to the Confident Blue mockup: a header
// (talent + state pill + "Engaging for <req>"), a message THREAD built from the
// event log (outreach_sent = me, response_received = them), the draft→preview→
// send OutreachComposer under the R8/R12 note ("you send every message"), and
// the right-column engagement-state STEPPER. All wired controls (transition,
// response, conversation, event log) are PRESERVED — only the layout changed.
//
// Refusal layer (G3 / R8 / R12): AI drafts, the recruiter sends; there is NO
// auto-send (the composer's only delivery path is review→send, unchanged). The
// "to confirm" facts panel from the mockup needs structured engagement fields
// the API does not expose → omitted (CARRY).

// The linear happy-path ladder the Stepper renders (mockup omits 'evaluated').
const STEPPER_LABELS = [
  'Surfaced',
  'Engaged',
  'Awaiting response',
  'Responded',
  'In conversation',
  'Ready for submittal',
  'Submitted',
];

const STATE_STEP: Record<EngagementState, number> = {
  surfaced: 0,
  evaluated: 0,
  engaged: 1,
  maybe: 1,
  passed: 1,
  awaiting_response: 2,
  responded: 3,
  in_conversation: 4,
  not_interested: 4,
  ready_for_submittal: 5,
  submitted: 6,
};

const STATE_TONE: Record<EngagementState, PillTone> = {
  surfaced: 'neutral',
  evaluated: 'neutral',
  engaged: 'brand',
  maybe: 'warn',
  passed: 'danger',
  awaiting_response: 'brand',
  responded: 'ok',
  in_conversation: 'info',
  not_interested: 'danger',
  ready_for_submittal: 'info',
  submitted: 'ok',
};

interface EngagementDetailViewProps {
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
  if (loading) return <p className="rc-muted-line">Loading engagement…</p>;
  if (error !== null) {
    return (
      <section>
        <InlineAlert variant="error">{error}</InlineAlert>
      </section>
    );
  }
  if (engagement === null || session === null) return null;

  const canWrite = hasScope(session, 'engagement:write');
  const canOutreach = hasScope(session, 'engagement:outreach');
  const outreachSentEvents = events.filter(
    (e) => e.event_type === 'outreach_sent',
  );
  const thread = buildThread(events);

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
      <div className="rc-ehead">
        <Avatar name={headerTalent} size="lg" />
        <div>
          <h1 className="rc-ehead__h">
            <span>{headerTalent}</span>
            <StatusPill tone={STATE_TONE[engagement.state]}>
              {ENGAGEMENT_STATE_LABELS[engagement.state]}
            </StatusPill>
          </h1>
          <div className="rc-ehead__ctx">
            Engaging for <b>{headerReq}</b>
          </div>
        </div>
      </div>
      <p className="rc-mt-16">
        <Link
          to={`/talent/${engagement.talent_id}`}
          className="rc-link-action"
        >
          ← Back to talent
        </Link>
      </p>

      <div className="rc-egrid">
        <div className="rc-stack">
          {thread.length > 0 ? (
            <Card flush>
              <CardHead title="Conversation" />
              <div className="rc-thread">
                {thread.map((m) => (
                  <div
                    key={m.id}
                    className={`rc-msg ${m.me ? 'rc-msg--me' : 'rc-msg--them'}`}
                  >
                    <div>
                      <div className="rc-msg__who">{m.who}</div>
                      <div className="rc-msg__bub">{m.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {canOutreach ? (
            <Card>
              <CardHead title="Outreach" />
              <div className="rc-draftnote">
                <SparkleIcon />
                <span>
                  <b>Drafted by Aramo</b> — review and edit before sending.
                </span>
              </div>
              <OutreachComposer
                engagementId={engagement.id}
                state={engagement.state}
                onSent={reload}
              />
              <p className="rc-sendnote">
                <InfoIcon />
                You send every message. Aramo drafts — it never sends on your
                behalf.
              </p>
            </Card>
          ) : null}

          {canWrite ? (
            <Card>
              <CardHead title="Move engagement" />
              <EngagementTransitionControl
                from={engagement.state}
                onSubmit={handleTransition}
              />
            </Card>
          ) : null}

          {canWrite ? (
            <Card>
              <CardHead title="Record a response" />
              <ResponseLogger
                outreachSentEvents={outreachSentEvents}
                onSubmit={handleResponse}
              />
            </Card>
          ) : null}

          {canWrite ? (
            <Card>
              <CardHead title="Record a conversation" />
              <ConversationLogger onSubmit={handleConversation} />
            </Card>
          ) : null}

          <Card>
            <CardHead title="Event log" />
            <EventLog events={events} />
          </Card>
        </div>

        <aside>
          <div className="rc-sidecard">
            <h3 className="rc-sidecard__h">Engagement state</h3>
            <Stepper
              steps={STEPPER_LABELS}
              currentIndex={STATE_STEP[engagement.state]}
            />
          </div>
        </aside>
      </div>
    </section>
  );
}

interface ThreadMessage {
  readonly id: string;
  readonly me: boolean;
  readonly who: string;
  readonly text: string;
}

// Build the conversation thread from the event log: a sent outreach is a "me"
// bubble carrying the final_text; a recorded response is a "them" bubble. The
// inbound message BODY is not persisted (only the response event), so a
// response renders as an acknowledgement line (CARRY: inbound message text).
function buildThread(
  events: readonly EngagementEventView[],
): readonly ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const e of events) {
    if (e.event_type === 'outreach_sent') {
      const p = e.event_payload as OutreachSentPayload;
      out.push({
        id: e.id,
        me: true,
        who: `You · ${formatWhen(e.created_at)}`,
        text: p.final_text,
      });
    } else if (e.event_type === 'response_received') {
      out.push({
        id: e.id,
        me: false,
        who: `Talent · ${formatWhen(e.created_at)}`,
        text: 'Replied to your message.',
      });
    }
  }
  return out;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function SparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v3M12 18v3M5 12H2M22 12h-3M6 6l-2-2M20 20l-2-2M6 18l-2 2M20 4l-2 2" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  );
}
