# Aramo Sign — Privacy Policy and Data-Processing Terms

| | |
|---|---|
| Document key | `sign.privacy_policy` |
| Version | 0.1.0 |
| Status | **DRAFT — LEGAL-PENDING.** Not approved. Must not be published until legal review and PO approval. |
| Baseline | `Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1-v1_0-LOCKED` §3.B |
| Operator | [Legal Company Name] — to be confirmed |
| Privacy contact | [To be completed] |

## 1. What we process

Described from what the service actually stores today:

| Category | Examples | Where it comes from |
|---|---|---|
| Account | name, email address, organization name, role assignments | the account holder and organization administrators |
| Sign-in | identity-provider subject, sign-in and session metadata | the Aramo sign-in service (Amazon Cognito) |
| Documents | uploaded PDF files, signed copies, execution certificates | the sender; the service when a document is completed |
| Signers | signer name and email address | the sender |
| Signing evidence | signing events in a hash-chained ledger, the disclosure version accepted, timestamps, the network address and browser reported by the signer's device | the signer's session |
| Billing | the payment provider's account and subscription references, plan, status and period dates, processed billing-event records | Stripe |
| Usage | counts of envelopes sent per billing period; storage used | the service |

Card numbers are entered on Stripe's pages and are not received or stored by Aramo.

## 2. Why we process it

To authenticate users, run signing workflows, deliver documents and notifications, keep signing
evidence, administer subscriptions and billing, provide support, prevent abuse and meet legal
obligations. Usage counts are kept even on unlimited plans, for capacity planning and abuse
detection.

**AI-assisted features.** The catalog lists an "AI Assist Summary" feature for Standard plans. It is
not built yet. Before it is enabled, this policy must describe what document data it sends, to which
provider, and the controls available to the Subscriber.

## 3. Roles

- For account, billing and service-administration data, Aramo acts for its own purposes.
- For documents and signer information a business Subscriber sends through the service, the
  Subscriber decides the purpose and Aramo processes the data on its behalf. Where required, this is
  set out in a Data Processing Agreement. [DPA to be drafted.]

## 4. Service providers (subprocessors)

The providers the current architecture uses. The final list must be verified against contracts,
regions and transfer mechanisms before publication.

| Provider | Purpose | Notes |
|---|---|---|
| Amazon Web Services | hosting (Lightsail), database, object storage (S3), email delivery (SES), sign-in (Cognito), secrets storage (Secrets Manager); optional key management (KMS) for evidence signing | region us-east-1 [to verify] |
| Stripe | payment collection, subscription billing, billing portal | Aramo stores only Stripe references |
| AI model providers configured by an organization (for example Anthropic, OpenAI) | used by Aramo ATS features with the organization's own credentials; not used by Aramo Sign today | to be listed only if a Sign feature uses them |

[International transfers and safeguards to be described after legal review.]

## 5. Security

Implemented today: per-organization data isolation enforced by the backend; encrypted transport
(HTTPS); signing links that are random, single-purpose and stored only as hashes; a hash-chained
signing ledger and a signed evidence manifest; access control by role; credentials kept in a secrets
store. Statements beyond these require verification before they are published.

## 6. Retention and deletion

Data is kept only as long as needed for the purposes above, contractual obligations, legal
requirements and evidence preservation. See the Document Retention, Export and Deletion Policy.
Access, correction, export or deletion requests may be limited where signing evidence must be kept.

## 7. Your rights and contact

[Applicable rights, jurisdiction-specific disclosures, the privacy contact and the complaint process
to be completed.]

## Required legal review

- Controller / processor allocation and the Data Processing Agreement.
- The verified subprocessor list, regions and transfer mechanisms.
- Jurisdiction-specific notices (for example GDPR / UK GDPR, US state privacy laws).
- Cookie / similar-technology disclosures for the web applications.
