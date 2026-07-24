import { Injectable } from '@nestjs/common';

import { loadIntakeConfig } from './intake.config.js';

// Per-IP in-memory token bucket (R-PUB5-1 — Redis explicitly rejected at the
// single-container nano tier). Capacity = INTAKE_RATE_LIMIT_PER_HOUR (default
// 5), refilled proportionally over a one-hour window. `nowMs` is a parameter so
// tests drive time deterministically (trip + reset) without a real clock.
interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

@Injectable()
export class RateLimitService {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillWindowMs = 60 * 60 * 1000;

  constructor() {
    this.capacity = loadIntakeConfig().ratePerHour;
  }

  tryConsume(key: string, nowMs: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.buckets.set(key, {
        tokens: this.capacity - 1,
        updatedAtMs: nowMs,
      });
      return true;
    }

    const elapsed = Math.max(0, nowMs - bucket.updatedAtMs);
    const refilled = (elapsed / this.refillWindowMs) * this.capacity;
    const tokens = Math.min(this.capacity, bucket.tokens + refilled);

    if (tokens < 1) {
      bucket.tokens = tokens;
      bucket.updatedAtMs = nowMs;
      return false;
    }

    bucket.tokens = tokens - 1;
    bucket.updatedAtMs = nowMs;
    return true;
  }
}
