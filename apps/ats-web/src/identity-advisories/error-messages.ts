import { ApiError } from '@aramo/fe-foundation';

// Plain-language mapping for the advisory worklist LIST fetch (mirrors
// ../sourcing/error-messages.ts). Switches on ApiError.status; never surfaces a
// raw envelope code. The RESOLVE flow (approve/dismiss) keeps its own mapping in
// the shared AdvisoryResolveDialog (advisoryErrorMessage).
export function advisoryListErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You do not have permission to review identity advisories.';
    }
    if (err.status === 404) {
      return 'These advisories could not be found.';
    }
    if (err.status === 409 || err.status === 400) {
      return 'This advisory was already resolved, or the input was rejected.';
    }
  }
  return 'The identity advisories could not be loaded. Please try again.';
}
