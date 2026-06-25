import { SettingsSection } from '../components';
import { DomainVerificationPanel } from '../domain/DomainVerificationPanel';

// Domain-Enforcement P2b §7 — Domain verification section (People & access group,
// alongside Security & SSO). The live, self-serve DNS-TXT ownership-proof surface:
// shows the TXT record to publish, then a "Check DNS record" button that flips the
// status to VERIFIED. INFORMATIONAL (gates nothing today; the model is shaped so a
// future self-service-signup gate can require VERIFIED).
export function DomainVerificationSection() {
  return (
    <SettingsSection
      title="Domain verification"
      description="Prove your organization controls its email domain by publishing an Aramo-issued token in a DNS TXT record. Verification is a trust signal today; it does not change who can sign in or be invited."
    >
      <DomainVerificationPanel />
    </SettingsSection>
  );
}
