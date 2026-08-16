import { ApiError } from '@aramo/fe-foundation';

// Track 7 / T7-P5 §8 — governed guarantee-term error → actionable UI copy. Covers the exact
// codes the create/revise flows can hit. Raw internal reason strings are never surfaced.

export function guaranteeTermsErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'PERMANENT_PLACEMENT_TERMS_OVERLAP':
        return 'These effective dates overlap an existing version. To supersede the current terms, use Revise.';
      case 'PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID':
        return 'The effective date is invalid — a revision cannot be backdated and must take effect after the current version starts.';
      case 'PERMANENT_PLACEMENT_TERMS_NOT_FOUND':
        return 'There are no current guarantee terms to revise. Create the initial terms first.';
      case 'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID':
        return 'Duration must be a positive number of days and the remedy policy must be one of the allowed values.';
      case 'PERMANENT_PLACEMENT_EXPOSURE_INVALID':
        return 'Exposure must be a non-negative amount with a valid currency.';
      case 'VALIDATION_ERROR':
        return 'Please check the form values and try again.';
      default:
        break;
    }
  }
  return 'Could not save the guarantee terms. Please try again.';
}
