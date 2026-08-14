import { ApiError } from '@aramo/fe-foundation';

// T8-P3 — product-safe error copy (directive §18). Derived from ApiError only;
// never surfaces raw DB errors, stack traces, secret material, or internal
// refusal-rule detail.

export function listErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You do not have access to requisition ingestion in this workspace.';
    }
    if (err.status >= 500) {
      return 'Requisition ingestion history is unavailable right now. Please try again.';
    }
  }
  return 'Could not load requisition ingestion history.';
}

export function detailErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return 'This ingestion batch was not found in this workspace.';
    }
    if (err.status === 403) {
      return 'You do not have access to this ingestion batch.';
    }
  }
  return 'Could not load this ingestion batch.';
}
