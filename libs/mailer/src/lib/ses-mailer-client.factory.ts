import { Injectable } from '@nestjs/common';
import { SESv2Client } from '@aws-sdk/client-sesv2';

import { loadMailerConfig, type MailerConfig } from './mailer.config.js';

// Email-S1 §2.1 — SESv2 client factory.
//
// Lazy-init, mirroring libs/object-storage S3ClientFactory: a single
// instance-level SESv2Client cached for the lifetime of the Nest
// singleton. The client (and the config load) are created on FIRST use,
// not at construction — so the provider can be eagerly instantiated by
// Nest even in stub mode without touching SES env or AWS.
//
// Credentials: SDK default chain (env / shared / instance-profile / IRSA)
// — NEVER hardcoded. Same path the S3 résumé adapter uses; on the single
// box these resolve from the static AWS_* env creds.

@Injectable()
export class SesMailerClientFactory {
  private cached: SESv2Client | null = null;
  private cachedConfig: MailerConfig | null = null;

  getClient(): SESv2Client {
    if (this.cached !== null) return this.cached;
    const config = this.getConfig();
    this.cached = new SESv2Client({ region: config.region });
    return this.cached;
  }

  getConfig(): MailerConfig {
    if (this.cachedConfig === null) {
      this.cachedConfig = loadMailerConfig();
    }
    return this.cachedConfig;
  }
}
