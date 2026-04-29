import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

const REQUEST_ID_HEADER = 'x-request-id';
// RFC 4122 UUID (any version) — used to validate a client-supplied X-Request-ID.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

// PR-2 precedent: every endpoint reads X-Request-ID if present (validated as
// a UUID), generates UUID v7 if absent or invalid, attaches to request.requestId,
// and echoes the value as response header. Error envelopes pull from
// request.requestId. Any future endpoint inherits this without further wiring.
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.header(REQUEST_ID_HEADER);
    const requestId =
      incoming !== undefined && UUID_REGEX.test(incoming) ? incoming : uuidv7();
    request.requestId = requestId;
    response.setHeader('X-Request-ID', requestId);
    next();
  }
}
