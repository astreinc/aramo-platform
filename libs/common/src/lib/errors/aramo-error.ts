import type { ErrorCode } from './error-codes.js';

export interface AramoErrorContext {
  requestId: string;
  details?: Record<string, unknown>;
  displayMessage?: string;
  logMessage?: string;
}

// Base error class. Thrown anywhere in the app where a structured response
// is required; converted to the locked Phase 5 envelope by AramoExceptionFilter.
export class AramoError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly context: AramoErrorContext;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    context: AramoErrorContext,
  ) {
    super(message);
    this.name = 'AramoError';
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
  }
}
