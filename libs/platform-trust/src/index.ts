// TR-2b B2a (Aramo-TR2b-B2-Directive) — platform-trust public surface. The
// dormant-link substrate (P4 notice lifecycle). PII-free by design — inside the
// D3 wall (NO tenant_id, NO PII), enforced by the platform-trust privacy-wall
// spec that joins the identity-index privacy-wall CI job.
export { PlatformTrustModule } from './lib/platform-trust.module.js';
export {
  PlatformTrustRepository,
  type DormantLinkRow,
} from './lib/platform-trust.repository.js';
export {
  DORMANT_LINK_STATUSES,
  type DormantLinkStatus,
} from './lib/dormant-link-status.js';
