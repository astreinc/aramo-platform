import type { CalendarEventType } from './calendar-event-type.js';

// CalendarEventView — read-projection returned by GET / LIST.
//
// Timestamps flattened to ISO strings at the controller boundary.
export interface CalendarEventView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  owner_id: string;
  type: CalendarEventType;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  created_at: string;
  updated_at: string;
}
