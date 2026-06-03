import type { CalendarEventType } from './calendar-event-type.js';

// UpdateCalendarEventRequestDto — PATCH /v1/calendar-events/:id payload.
//
// All fields optional (partial update). owner_id is not editable — the
// event's owner is fixed at creation time. tenant_id is never accepted
// from the body.
export interface UpdateCalendarEventRequestDto {
  type?: CalendarEventType;
  title?: string;
  description?: string | null;
  starts_at?: string;
  ends_at?: string | null;
  all_day?: boolean;
}
