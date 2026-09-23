import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';
import { EsignModule, SIGNING_NOTIFICATION_PORT } from '@aramo/esign';
import { MailerModule } from '@aramo/mailer';

import { EsignProviderController, EsignSignerController } from './esign-http.controller.js';
import { NativeAramoSignatureProvider } from './native-aramo-signature.provider.js';
import { MailerSigningNotificationAdapter } from './mailer-signing-notification.adapter.js';

// DOC-3 — apps/esign-service composition root. Composes the ATS-neutral E-Sign
// domain (EsignModule) + binds the concrete SigningNotificationPort to the
// MailerPort (MailerModule, SES/stub by env). The KMS EvidenceManifestSignerPort
// override is DOC-4 (EsignModule binds the DOC-3 software signer by default).
@Module({
  imports: [CommonModule, EsignModule, MailerModule],
  controllers: [EsignProviderController, EsignSignerController],
  providers: [
    NativeAramoSignatureProvider,
    { provide: SIGNING_NOTIFICATION_PORT, useClass: MailerSigningNotificationAdapter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
