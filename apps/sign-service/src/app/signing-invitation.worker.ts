import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { SigningInvitationService } from '@aramo/sign';

// Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED §4 — the retry path for SEQUENTIAL
// next-signer invitations. The signer controller delivers an invitation right after
// the previous signer completes; this worker delivers any intent that was recorded but
// not delivered (a crash, a provider failure, a stale claim). Same shape as
// EsignExpiryWorker: an interval with an overlap latch; several processes are safe
// (each intent is claimed by compare-and-set). Disabled with
// SIGN_INVITATION_WORKER_ENABLED=0; interval SIGN_INVITATION_INTERVAL_MS (default 60 s).
@Injectable()
export class SigningInvitationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SigningInvitationWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly invitations: SigningInvitationService) {}

  onApplicationBootstrap(): void {
    if (process.env['SIGN_INVITATION_WORKER_ENABLED'] === '0') return;
    const intervalMs = Number(process.env['SIGN_INVITATION_INTERVAL_MS'] ?? '60000');
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One pass. Public so tests can drive it deterministically. Returns how many
  // invitations this pass delivered.
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const sent = await this.invitations.dispatch({}, now);
      if (sent > 0) this.logger.log(`delivered ${sent} pending signing invitation(s)`);
      return sent;
    } catch (err) {
      this.logger.warn(`invitation tick failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
