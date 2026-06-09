import { ApiError } from '@aramo/fe-foundation';

// Search FE /search — per-section error copy. Each fanned-out ?q= call
// resolves independently (Promise.allSettled isolation); a section that
// errors shows this message without affecting the others. The FE only
// calls held-scope endpoints, so a 403 here is unexpected — but mapped
// honestly if the scope set drifts mid-session.
export function sectionErrorMessage(entityLabel: string, error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return `You do not have permission to search ${entityLabel.toLowerCase()}.`;
  }
  return `${entityLabel} search could not be completed.`;
}
