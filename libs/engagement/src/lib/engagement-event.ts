// EngagementEventType — closed-list runtime const tuple + derived type
// for TalentEngagementEvent (M5 PR-2).
//
// Per M5 PR-2 directive §4.3 + Charter v1.2 §4.4 Ruling D (engagement
// event-log scope). Five event types covering the M5 engagement
// workflow surface:
//   - state_transition: state-machine transition event (M5 PR-4
//     consumer wires the actual transition emit-path)
//   - outreach_drafted: AI draft generated + persisted PENDING, NOT yet
//     delivered (Outreach Draft/Preview Directive v1.0 / Amendment v1.1
//     §2 — the human-in-the-loop preview substrate; carries the AI draft
//     text + ai_draft_audit_record_id; appended by POST .../outreach/draft
//     with NO delivery/outbox/transition side-effect; multiple per
//     engagement permitted, append-only)
//   - outreach_sent: outbound message dispatched (Outreach Draft/Preview
//     SEND — carries the FINAL sent text + the source_draft_event_id
//     back-reference; the draft may have been edited, so drafted text and
//     sent text both persist and may differ)
//   - response_received: inbound response captured (M5 PR-7 consumer)
//   - conversation_started: in_conversation transition crossed (M5 PR-8
//     consumer; emitted alongside the responded -> in_conversation
//     state_transition event for richer audit)
//
// Closed-list discipline (M3 PR-9 + M4 PR-7 + M5 PR-1 precedent): the
// runtime const tuple lets application-layer validators close the
// list at compile time and at runtime. Future event types are added
// via explicit directive amendment.

export const ENGAGEMENT_EVENT_TYPE_VALUES = [
  'state_transition',
  'outreach_drafted',
  'outreach_sent',
  'response_received',
  'conversation_started',
] as const;

export type EngagementEventTypeValue = (typeof ENGAGEMENT_EVENT_TYPE_VALUES)[number];
