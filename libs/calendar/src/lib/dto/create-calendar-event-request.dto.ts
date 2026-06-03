import type { CalendarEventType } from './calendar-event-type.js';

// CreateCalendarEventRequestDto — POST /v1/calendar-events payload.
//
// tenant_id is NOT accepted from the body — derived from AuthContext.tenant_id
// at the controller layer (cross-tenant write defense per Architecture §7.2).
// owner_id is derived from AuthContext.sub at the controller layer; not
// settable from the body (the event's owner is its creator, period).
// site_id, when provided, is matched against AuthContext.site_id by the
// RolesGuard via @RequireSiteMatch.
export interface CreateCalendarEventRequestDto {
  type: CalendarEventType;
  title: string;
  starts_at: string;
  ends_at?: string;
  all_day?: boolean;
  description?: string;
  site_id?: string;
}
