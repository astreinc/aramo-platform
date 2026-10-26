import { type DynamicModule, Module } from '@nestjs/common';
import { IdentityRepository, PrismaService as IdentityPrismaService } from '@aramo/identity';
import { MailerModule } from '@aramo/mailer';
import { LegalChangeNoticeRepository, SubscriptionPrismaService } from '@aramo/subscription';

// Privacy Notice 1.1 remediation E-6 — the minimal application context of the operator
// command: the identity read (account holders), the subscription evidence store and, in send
// mode only, the mailer (MailerModule binds SES, the stub or the local outbox from
// MAILER_PROVIDER, failing loud on misconfiguration). A dry run never binds a mailer.
// No HTTP server, no workers, no schedulers.
@Module({})
export class LegalChangeNoticeCliModule {
  static forMode(mode: 'DRY_RUN' | 'SEND'): DynamicModule {
    return {
      module: LegalChangeNoticeCliModule,
      imports: mode === 'SEND' ? [MailerModule] : [],
      providers: [IdentityPrismaService, IdentityRepository, SubscriptionPrismaService, LegalChangeNoticeRepository],
    };
  }
}
