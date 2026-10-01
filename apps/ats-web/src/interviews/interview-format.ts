import type { InterviewSessionState } from './interviews-api';

// Human-facing labels for the canonical InterviewSession states (Calendar/Interview
// §16 — state labels are the canonical states translated for the recruiter, never a
// re-derived meaning).
export const INTERVIEW_STATE_LABEL: Record<InterviewSessionState, string> = {
  SCHEDULED: 'Scheduled',
  RESCHEDULED: 'Rescheduled',
  COMPLETED: 'Completed',
  CANCELED: 'Canceled',
  NO_SHOW: 'No-show',
};

export function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const mondayIndex = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - mondayIndex);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function dayHeading(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function requisitionLabel(
  requisition_number: number | null,
  requisition_title: string | null,
  company_name: string | null,
): string {
  const parts: string[] = [];
  if (requisition_number !== null) parts.push(`REQ-${requisition_number}`);
  if (requisition_title !== null && requisition_title.length > 0)
    parts.push(requisition_title);
  if (company_name !== null && company_name.length > 0) parts.push(company_name);
  return parts.join(' · ');
}
