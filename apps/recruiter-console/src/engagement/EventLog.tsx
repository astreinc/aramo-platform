import { Card } from '@aramo/fe-foundation';

import {
  ENGAGEMENT_EVENT_TYPE_LABELS,
  ENGAGEMENT_STATE_LABELS,
  type ConversationStartedPayload,
  type EngagementEventView,
  type EngagementState,
  type OutreachDraftedPayload,
  type OutreachSentPayload,
  type ResponseReceivedPayload,
  type StateTransitionPayload,
} from './types';

// The engagement event log (§4). Renders the 5 EngagementEventType, each
// narrowed on event_type with a per-type payload summary. The outreach
// text (draft_text / final_text) is persisted in the event log per the
// ADR-0015 addendum and rendered here. Pure presentational — the parent
// owns the fetch (the events also feed the response picker).

function stateLabel(s: EngagementState | null): string {
  return s === null ? 'created' : ENGAGEMENT_STATE_LABELS[s];
}

function eventSummary(event: EngagementEventView): string {
  switch (event.event_type) {
    case 'state_transition': {
      const p = event.event_payload as StateTransitionPayload;
      return `${stateLabel(p.from_state)} → ${stateLabel(p.to_state)}`;
    }
    case 'outreach_drafted': {
      const p = event.event_payload as OutreachDraftedPayload;
      return p.draft_text;
    }
    case 'outreach_sent': {
      const p = event.event_payload as OutreachSentPayload;
      return p.final_text;
    }
    case 'response_received': {
      const p = event.event_payload as ResponseReceivedPayload;
      return `Response received ${p.response_received_at}`;
    }
    case 'conversation_started': {
      const p = event.event_payload as ConversationStartedPayload;
      return `Conversation started ${p.conversation_started_at}`;
    }
    default:
      return '';
  }
}

// outreach_sent carries a back-reference to the source draft (the editable
// trail). Surface that the sent text may differ from the AI draft.
function editedTrailNote(event: EngagementEventView): string | null {
  if (event.event_type !== 'outreach_sent') return null;
  return 'Sent text (reviewed before send)';
}

export function EventLog({
  events,
}: {
  events: readonly EngagementEventView[];
}) {
  if (events.length === 0) {
    return <p>No engagement events recorded yet.</p>;
  }
  return (
    <ul className="timeline">
      {events.map((event) => {
        const trail = editedTrailNote(event);
        return (
          <li key={event.id} className="timeline__item">
            <Card>
              <p className="engagement-event__type">
                <strong>
                  {ENGAGEMENT_EVENT_TYPE_LABELS[event.event_type]}
                </strong>
              </p>
              <p className="engagement-event__summary">
                {eventSummary(event)}
              </p>
              {trail !== null ? (
                <p className="engagement-event__trail">{trail}</p>
              ) : null}
              <time dateTime={event.created_at}>{event.created_at}</time>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
