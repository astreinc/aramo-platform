import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AramoError } from './aramo-error.js';
import type { ErrorCode } from './error-codes.js';

interface ErrorEnvelope {
  error: {
    code: ErrorCode | string;
    message: string;
    display_message?: string;
    log_message?: string;
    request_id: string;
    details: Record<string, unknown>;
  };
}

// Converts AramoError (and NestJS HttpException) to the locked Phase 5
// nested error envelope. Three branches:
//   1. AramoError — render the envelope from the error's own fields.
//   2. HttpException — explicit status-code → ErrorCode mapping.
//   3. Anything else — INTERNAL_ERROR (500), the registry's catch-all.
@Catch()
export class AramoExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    if (exception instanceof AramoError) {
      const envelope: ErrorEnvelope = {
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.context.displayMessage !== undefined && {
            display_message: exception.context.displayMessage,
          }),
          ...(exception.context.logMessage !== undefined && {
            log_message: exception.context.logMessage,
          }),
          request_id: exception.context.requestId,
          details: exception.context.details ?? {},
        },
      };
      response.status(exception.statusCode).json(envelope);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const httpResponse = exception.getResponse();
      const message =
        typeof httpResponse === 'string'
          ? httpResponse
          : ((httpResponse as { message?: string | string[] }).message
              ?.toString() ?? exception.message);
      // Status-code-keyed mapping. Any status not enumerated falls through
      // to INTERNAL_ERROR (the registry's catch-all 5xx code).
      let code: ErrorCode;
      switch (status) {
        case 400:
          code = 'VALIDATION_ERROR';
          break;
        case 401:
          code = 'AUTH_REQUIRED';
          break;
        case 403:
          code = 'TENANT_ACCESS_DENIED';
          break;
        case 409:
          code = 'IDEMPOTENCY_KEY_CONFLICT';
          break;
        default:
          code = 'INTERNAL_ERROR';
      }
      const envelope: ErrorEnvelope = {
        error: {
          code,
          message,
          request_id: requestId,
          details: {},
        },
      };
      response.status(status).json(envelope);
      return;
    }

    // Unhandled exception — registry catch-all per Phase 5
    // "System & Processing" (aramo-API-contract.md line 1372).
    const envelope: ErrorEnvelope = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal error',
        request_id: requestId,
        details: {},
      },
    };
    response.status(500).json(envelope);
  }
}
