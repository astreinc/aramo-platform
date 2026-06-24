// @aramo/mailer — Aramo's generic transactional-email capability (Email-S1).
//
// Public surface: the MailerModule (binds MAILER_PORT by env) + the port
// token + types. Consumers inject @Inject(MAILER_PORT) a MailerPort and
// call send({ to, subject, html, text? }). The concrete adapters
// (SesMailerAdapter / StubMailerAdapter) are exported for the DI
// resolution spec + future composition, but callers depend only on the
// port.
export { MailerModule } from './lib/mailer.module.js';
export { MAILER_PORT } from './lib/tokens.js';
export type {
  MailerPort,
  SendEmailInput,
  SendEmailResult,
} from './lib/mailer.port.js';
export { SesMailerAdapter } from './lib/ses-mailer.adapter.js';
export { StubMailerAdapter } from './lib/stub-mailer.adapter.js';
export { SesMailerClientFactory } from './lib/ses-mailer-client.factory.js';
export {
  loadMailerConfig,
  type MailerConfig,
  type MailerProvider,
} from './lib/mailer.config.js';
