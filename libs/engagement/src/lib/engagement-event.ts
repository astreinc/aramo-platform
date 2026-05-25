// EngagementEventType — closed-list runtime const tuple + derived type
// for TalentEngagementEvent (M5 PR-2).
//
// Per M5 PR-2 directive §4.3 + Charter v1.2 §4.4 Ruling D (engagement
// event-log scope). Four event types covering the M5 engagement
// workflow surface:
//   - state_transition: state-machine transition event (M5 PR-4
//     consumer wires the actual transition emit-path)
//   - outreach_sent: outbound message dispatched (M5 PR-6 consumer)
//   - response_received: inbound response captured (M5 PR-6 consumer)
//   - conversation_started: in_conversation transition crossed (M5 PR-6
//     consumer; emitted alongside the responded -> in_conversation
//     state_transition event for richer audit)
//
// Closed-list discipline (M3 PR-9 + M4 PR-7 + M5 PR-1 precedent): the
// runtime const tuple lets application-layer validators close the
// list at compile time and at runtime. Future event types are added
// via explicit directive amendment.

export const ENGAGEMENT_EVENT_TYPE_VALUES = [
  'state_transition',
  'outreach_sent',
  'response_received',
  'conversation_started',
] as const;

export type EngagementEventTypeValue = (typeof ENGAGEMENT_EVENT_TYPE_VALUES)[number];
