import { HttpException } from '@nestjs/common';
import { LifecycleRefusedError } from '@aramo/intelligence-core';
import { LIFECYCLE_REFUSAL_HTTP_STATUS } from '@aramo/intelligence-contracts';

// ATI-SEP-1 T10 — LifecycleRefusedError → { error: { code, message, issues? } }
// with the status of LIFECYCLE_REFUSAL_HTTP_STATUS (contracts).
export function mapLifecycleError(err: unknown): never {
  if (err instanceof LifecycleRefusedError) {
    throw new HttpException({ error: { code: err.code, message: err.message, ...err.details } }, LIFECYCLE_REFUSAL_HTTP_STATUS[err.code]);
  }
  throw err;
}

/** Run `fn`, mapping lifecycle refusals to HTTP. */
export async function lifecycle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    mapLifecycleError(err);
  }
}
