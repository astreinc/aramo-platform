# Aramo Sign — Terms of Service (combined Business and Personal)

| | |
|---|---|
| Structure | **Part A** applies to everyone. **Part B** applies to Business accounts. **Part C** applies to Personal accounts. **Part D** holds country-specific terms. Where Part C or Part D conflicts with Part A for an individual, Part C or D controls. |
| Related documents | Aramo Privacy Notice (`aramo.privacy_notice`) · Aramo Acceptable Use Policy (`aramo.acceptable_use_policy`) · Electronic Signature Consent Disclosure for signers (`sign.esign_consent_disclosure`) · Data Processing Addendum for Business accounts *(to be drafted)* |
| Operator | **Astre Consulting Services Inc**, a Virginia corporation, 2909 Gettysburg Sq, Vienna, VA 22181, USA ("Aramo", "we", "us") |
| Effective date | [Date of publication] |


---

# PART A — TERMS FOR EVERYONE

## A1. About these Terms

A1.1 These Terms are an agreement between you and Aramo for your use of Aramo Sign: the websites at
sign.aramo.ai, the related apps, emails, APIs and features (the "Service").

A1.2 **Which parts apply to you.**
- If you open or use a **Business account** for a company, organization or other entity, Parts A,
  B and D apply. "You" then means that entity (the "Subscriber") and the people it authorizes.
- If you open a **Personal account** for yourself, Parts A, C and D apply.
- If you only **sign** a document someone sent you, you do not need an account; section A3.3 and
  the Electronic Signature Consent Disclosure apply to you.

A1.3 By checking the box at signup, by signing an order, or by using the Service, you agree to these
Terms, the **Acceptable Use Policy** and the plan details shown to you. Please also read the
**Privacy Notice**.

A1.4 If you do not agree, do not create an account or use the Service.

## A2. Accounts and security

A2.1 You must give accurate information and keep it current.

A2.2 **Sign-in.** You sign in through a supported identity provider: currently Microsoft and Google
for Business accounts, and Google for Personal accounts. Aramo does not create or store a password
for you. You are responsible for keeping your identity-provider account secure.

A2.3 You are responsible for activity on your account, except activity caused by our own failure to
use reasonable security. Tell us promptly at support@aramo.ai if you think your account has been
misused.

## A3. How Aramo Sign works

A3.1 **Sending.** You upload a document, add recipients (signers, in-person signers and people who
receive a copy) and signing fields, and send it. Signers can be asked in parallel or in a set order.

A3.2 **Signing.** Aramo emails each signer a secure link. Signers do not need an Aramo account.
Before signing, each signer agrees to use electronic records and signatures (the Electronic
Signature Consent Disclosure).

A3.3 **Signer identity.** By default, a signer is verified only by access to the email address the
sender entered, or, for in-person signing, by the sender who hosts the session. Aramo does not
currently offer text-message, government-ID or knowledge-based verification.

A3.4 **Evidence.** For each completed document, Aramo keeps an evidence record:
- a completion certificate;
- an append-only, hash-chained log of the signing events;
- the consent each signer gave;
- timestamps;
- the network address and browser reported by each signer's device;
- a digital fingerprint (hash) of each signed document;
- an evidence summary digitally signed with a key held in a hardware-backed key service.

The evidence record helps show what happened. **It does not by itself guarantee that a court, agency
or other person will accept a signature.**

A3.5 **Notices to signers.** The Service sends signers requests, reminders and notices that a
document was completed, declined, voided or expired. These emails identify the sender.

## A4. Electronic signatures: your responsibility

A4.1 **Aramo is not a party to your documents.** We provide technology. We do not review the
content, fairness or legality of your documents, or verify your signers beyond what section A3.3
describes.

A4.2 **You decide whether e-signature is right.** You are responsible for deciding:
- whether a document or transaction may be signed electronically;
- whether any signer is a **consumer** who must receive specific disclosures or consents under
  law, and for providing them where Aramo's standard consent disclosure is not enough;
- whether more identity checks, witnesses, notarization or special formalities are required;
- how long you must keep the signed records.

A4.3 **Some documents need more than an electronic signature.** Many places exclude or restrict
e-signatures for some documents, for example:
- wills and testamentary trusts;
- certain family-law and court documents;
- some real-estate transfers;
- certain statutory notices (such as eviction, foreclosure or utility shut-off).

Rules differ by country and state. **Aramo does not give legal advice.**

A4.4 **Type of signature.** Aramo Sign creates a simple electronic signature:
- **in the US**, an electronic signature under the federal ESIGN Act and state UETA laws;
- **in India**, see section D2.

It is not a notarized signature, a qualified electronic signature or a digital signature
certificate.

## A5. Your content and your data

A5.1 **You own your content.** You keep all rights in the documents and information you upload or
create in the Service ("Your Content").

A5.2 **Our limited permission.** You give Aramo permission to host, process, transmit, display and
store Your Content **only**:
- to provide the Service to you and your recipients;
- to keep evidence records;
- to comply with law;
- to protect the Service and others (section A8).

A5.3 **What we do not do.** We do not sell Your Content. We do not use Your Content to train
artificial-intelligence models.

A5.4 **Usage information.** We may use information about how the Service is used (for example
volumes and performance), in aggregated or de-identified form that does not identify you or Your
Content, to operate, secure and improve the Service.

A5.5 **Where data is stored.** The Service is hosted in the United States (AWS, us-east-1). The
Privacy Notice lists the service providers we use and explains international transfers.

A5.6 **Security.** We use reasonable technical and organizational measures, including:
- encryption of stored documents with managed keys;
- encryption in transit;
- access controls;
- encrypted backups.

We will notify affected users of a security breach involving Your Content without undue delay and as
the law requires.

## A6. Retention, the Deleted folder and purge

A6.1 **Default: kept.** Completed, declined and voided documents and their evidence are kept until
they are purged under this section A6, or under section B7 or C6 when an account closes.

A6.2 **Deleted folder.** Any party with an Aramo account can move a finished envelope to its own
**Deleted** folder. This hides it from that party only. Other parties keep their copies. A deleted
envelope can be restored until it is purged.

A6.3 **Purge.**
- **Business accounts:** a Business account administrator can set a retention period of 1 to
  9,999 days after an envelope is completed, declined or voided, choose what a purge removes, purge
  an individual envelope, or purge every envelope sent from or signed by a given email address.
- **All accounts:** when every party with an Aramo account has deleted an envelope, it is queued for
  purge.
- **Purge queue:** a purge is queued for **14 days** before it runs. During that time an
  administrator can cancel it.

A6.4 **What a purge removes.** Depending on the level chosen:
- **(a) documents:** the original and signed documents and the certificate document;
- **(b) documents and details:** also the envelope's subject, message, document names and field
  values;
- **(c) documents, details and personal data:** also recipient names and email addresses, network
  addresses and browser details.

A6.5 **What a purge keeps.** We keep:
- a record that the envelope existed and its status;
- the evidence summary, which contains identifiers and fingerprints, not document content;
- the signing log, with personal data redacted at level (c).

This lets the integrity of past signings still be shown.

A6.6 **Purge is permanent.** Purged documents cannot be recovered by you or by us. Download anything
you want to keep before you purge, or before a retention period ends.

A6.7 **Legal holds.** We will not run a purge while an account is under a legal hold that we have
applied, for example because of a legal claim, a court order or an investigation.

A6.8 **Backups.** Copies in our encrypted backups expire on their normal backup schedule after a
purge. We do not restore purged data from backups except as the law requires.

A6.9 **Signers keep their copies.** Recipients who received a completed copy by email keep it. A
purge or account closure does not reach their mailboxes. Keep your own copies of important
documents; the Service is not a legal records-retention service.


## A7. Acceptable use

A7.1 You must follow the **Acceptable Use Policy**. In short, you must not use the Service to:
- deceive, defraud or harm anyone;
- send phishing, fake invoices or requests that pretend to come from someone else;
- collect passwords, financial or other sensitive data you are not entitled to;
- send spam or unwanted bulk requests;
- harass or threaten anyone;
- send unlawful or infringing content;
- spread malware;
- get around limits, verification or security measures.

A7.2 You must not:
- copy, modify or reverse engineer the Service, except where the law allows;
- resell, rent or sublicense the Service without our written agreement;
- build a competing service from it;
- access it by automated means other than through our published API.

## A8. Safety, abuse prevention and enforcement

A8.1 **Automated protection.** To protect recipients and the Service we use automated checks at
signup and when documents are sent, for example:
- robot-detection results;
- unusual sending patterns;
- links and wording typical of scams;
- reports from recipients.

These checks may lead to:
- verification requests;
- sending limits;
- review holds;
- paused sending.

The Privacy Notice explains them.

A8.2 **Reports.** Signing emails include a "Report this email" link. Reports go to our team, and a
report may pause sending from the account while we review it. You can also report abuse or security
issues to support@aramo.ai.

A8.3 **What we may do.** If we reasonably believe that an account breaks these Terms or the
Acceptable Use Policy, creates risk or harm for others, or that the law requires it, we may:
- warn the account;
- require verification;
- void pending requests;
- pause sending;
- suspend or close the account;
- report unlawful activity to the authorities.

Where reasonable and lawful we will tell you why and let you respond. We may act first when needed to
prevent harm. A person at Aramo can review any automated decision on request.

A8.4 **Signed documents survive enforcement.** Suspending sending never invalidates documents already
signed and never removes their evidence. We will normally let you download completed documents unless
the law requires otherwise or they are evidence in a fraud investigation.

## A9. Third-party services

The Service relies on third parties, including identity providers, email delivery, robot detection,
hosting and payment processing. Their terms may also apply to you, for example your identity
provider's terms. We are responsible for the providers we choose to run the Service, but not for
third-party services you choose to connect.

## A10. Changes to the Service and to these Terms

A10.1 **The Service.** We may add, change or remove features. Features shown as "not yet available"
in a plan are not part of that plan until we release them.

A10.2 **These Terms.**
- For material changes we will give at least **30 days'** notice by email or in the Service,
  unless a change is required sooner by law or to address abuse or security.
- If you do not agree, you may stop using the Service or close your account before the change
  takes effect. Otherwise the updated Terms apply from their effective date.
- Section B5 covers price changes for paid Business plans.
- Section C3 covers changes to the free Personal plan.

## A11. Disclaimers

A11.1 Except as stated in Part B for paid plans, the Service is provided **"as is" and "as
available"**. We do not promise that it will be uninterrupted or error-free, or that any document or
signature will be accepted for a particular purpose.

A11.2 To the extent the law allows, we disclaim implied warranties of merchantability, fitness for a
particular purpose and non-infringement.

A11.3 **Nothing in these Terms limits rights you have as a consumer that cannot be waived by
contract** (see Parts C and D).

## A12. Limitation of liability

A12.1 To the extent the law allows, Aramo is not liable for indirect, incidental, special,
consequential or punitive damages, or for lost profits, revenue, data or goodwill.

A12.2 **The cap:** Business accounts, section B9; Personal accounts, section C7.

A12.3 These limits do not apply to liability that cannot be limited by law, including liability for
death or personal injury caused by negligence, fraud, or gross negligence or wilful misconduct where
the law does not allow it to be limited.

A12.4 Aramo is not responsible for the content, validity or enforceability of documents, for what
parties agree, or for the conduct of senders or signers.

## A13. Sanctions and export

You may not use the Service if you are on a government sanctions or restricted-party list, act for
someone who is, or are located where US sanctions prohibit the Service. We may block access and close
accounts to comply with sanctions and export laws.

## A14. Disputes and governing law

A14.1 **Talk to us first.** Contact support@aramo.ai. We will try to resolve an issue informally
within **60 days**.

A14.2 **Governing law and courts.** Unless Part D says otherwise, these Terms are governed by the
laws of the **Commonwealth of Virginia** and applicable US federal law, and disputes are subject to
the exclusive jurisdiction of the state and federal courts in **Fairfax County, Virginia**.

## A15. General

A15.1 **Entire agreement.** These Terms, the Acceptable Use Policy, the plan details and, for
Business accounts, any signed order form and the Data Processing Addendum, are the entire agreement
about the Service. If a signed order form conflicts with these Terms, the order form controls.

A15.2 **Assignment.** You may not transfer your account or these Terms without our consent. We may
transfer them as part of a merger, acquisition or sale of assets, with notice, provided your rights
are not reduced.

A15.3 **Severability and waiver.** If part of these Terms is unenforceable, the rest stays in effect.
If we do not enforce a right, that is not a waiver.

A15.4 **Notices.** We send notices to the account email or show them in the Service. You can reach
us at support@aramo.ai or by post at the address above.

A15.5 **Language.** If we provide a translation, the English version controls to the extent the law
allows.

A15.6 **Events beyond control.** Neither party is responsible for delays or failures caused by events
reasonably beyond its control, except payment obligations.

A15.7 **Survival.** Sections that by their nature should continue survive termination, including
A4, A5, A6, A11, A12, A14, A15, B6, B7, B9 and B10, and C6 and C7.

---

# PART B — BUSINESS ACCOUNTS

## B1. Who may open a Business account

B1.1 A Business account is opened by a person authorized to bind the Subscriber, using a work email
address on the Subscriber's own domain. That person confirms the authority and that they are at least
18.

B1.2 The Subscriber is responsible for:
- its administrators and members;
- their compliance with these Terms;
- managing who has access.

## B2. Administrators and members

B2.1 Administrators manage the account, members and roles, settings (including retention and purge,
section A6), integrations and billing.

B2.2 Members see and act on envelopes according to their role. Envelopes belong to the Subscriber,
not to the individual member who sent them.

## B3. Plans and included usage

B3.1 **Current plans** (prices in USD, excluding taxes):

| Plan | Price | Commitment | Included |
|---|---|---|---|
| Standard Business | $15 per month per organization | 12 months, billed monthly | Unlimited envelopes for legitimate business use; 10 GB storage; team collaboration; retention and purge administration; API and webhooks |
| Standard Professional | $20 per month per organization | 12 months, billed monthly | Everything in Standard Business, with 25 GB storage |
| Enterprise | By agreement | By agreement | Limits, storage, support and capabilities as set in an order form |


B3.2 **Unlimited use.** "Unlimited" plans have no fixed monthly number of envelopes. Use remains
subject to legitimate business purposes, technical and security limits, and protection against
automated abuse, unlawful activity and serious interference with the Service. We will not apply an
undisclosed numerical limit to ordinary use of a plan advertised as unlimited. Any fair-use action
follows these Terms.

B3.3 **Storage.** When storage is full, new uploads are refused. Nothing already stored is removed
because storage is full.

B3.4 **Usage included with Aramo ATS.** Where Aramo Sign usage is included with an Aramo ATS
subscription, that usage is governed by these Terms and by the Aramo ATS agreement.

## B4. Payment

B4.1 Payment is collected by our payment processor (Stripe). Aramo does not receive or store full card
numbers.

B4.2 By completing checkout, the Subscriber authorizes the recurring charges shown there, plus
applicable taxes.

B4.3 **Failed payments.** If a payment fails, we may stop new sending after a grace period of
**7 calendar days** until payment is made (section B7.3).

B4.4 Billing disputes must be raised within **30 calendar days** of the charge.

## B5. Renewal, cancellation and price changes

B5.1 **Renewal.** At the end of each 12-month commitment, the subscription automatically renews for
another 12-month period unless the Subscriber cancels through the online billing settings at least
5 business days before the renewal date. Aramo will provide renewal notices as required by applicable
law.

B5.2 **Cancellation.** Cancellation takes effect at the end of the current commitment period.

B5.3 **Refunds.**

B5.4 **Price changes** take effect at the next renewal, with at least **30 days'** notice.

## B6. Data processing

B6.1 For Personal Data in Your Content, the Subscriber is the controller, and Aramo processes it on
the Subscriber's behalf under the **Data Processing Addendum**.

B6.2 The Subscriber is responsible for having a lawful basis to send documents and recipients'
information through the Service.

## B7. Suspension, termination and your data

B7.1 Either party may terminate for the other's material breach that is not cured within **30 days**
of notice, or immediately for insolvency.

B7.2 We may suspend new sending for a serious security issue, or as section A8 allows.

B7.3 We may suspend new sending for an unpaid balance after the grace period in section B4.3.

B7.4 **Effect of suspension or termination:**
- New sending stops.
- Envelopes already sent can still be signed, and completed ones still complete.
- Signed documents and their evidence are **not deleted** because a subscription ends or a payment
  fails.

B7.5 **Export after termination.** The Subscriber can download completed documents and evidence for
**90 calendar days** after termination. After that period we may close the account and purge its data under
section A6, except records we must keep by law.

## B8. API and integrations

B8.1 The Service includes an API and webhooks for applications the Subscriber authorizes, including
the Aramo ATS integration. Webhooks notify authorized applications when an envelope is completed,
declined, voided, expired or queued for purge.

B8.2 The Subscriber must keep application credentials confidential, follow published rate limits and
documentation, and is responsible for the applications it authorizes and their use of the data.

B8.3 We may suspend an application or credential that threatens the Service or other users.

## B9. Warranties, liability and indemnities (Business)

B9.1 **Warranty.**

B9.2 **Cap.** To the extent the law allows, each party's total liability under these Terms is limited
to the **fees the Subscriber paid for the Service in the 12 months before the claim**.

B9.3 **Aramo's indemnity.** Aramo will defend the Subscriber against third-party claims that the
Service, as provided, infringes intellectual-property rights, and pay resulting damages.

B9.4 **Subscriber's indemnity.** The Subscriber will defend Aramo against third-party claims arising
from Your Content, the Subscriber's documents or transactions, or the Subscriber's breach of the
Acceptable Use Policy, sanctions or export laws, or section A4.

## B10. Confidentiality

Each party will protect the other's non-public information with reasonable care, use it only to
perform these Terms, and disclose it only as these Terms allow or the law requires. Your Content is
the Subscriber's confidential information.

---

# PART C — PERSONAL ACCOUNTS

*(This part carries over the live Personal Terms 1.0, with corrections marked.)*

## C1. Who can use a Personal account

C1.1 **Personal accounts are for individuals acting for themselves.** If you are acting for a company
or organization, use a Business account.

C1.2 You must:
- (a) be at least **18**, or the age of majority where you live if that is higher;
- (b) be able to form a binding contract;
- (c) **live in the United States or India**;
- (d) not be on a sanctions or restricted-party list, or act for anyone who is (section A13).

C1.3 **Where it is available.** Personal accounts are offered only to residents of the United States
and India. We check location using:
- the network location you sign up and send from;
- the residence you declare;
- where we ask for it, the country of your mobile number.

Using a VPN or other means to appear to be in the US or India when you are not breaches these Terms.


C1.4 You may have **one** Personal account, with **one user**. Do not share your sign-in. Do not
create more accounts to get more free envelopes.

## C2. Verification and review

To protect people from scams we may ask you to verify your email, and later your phone, at signup,
before sending, or when unusual activity is detected. We may hold an account for manual review before
it can send (section A8).

## C3. The Free Personal plan

C3.1 **Included:**
- up to **5 envelopes per month**, renewing monthly; unused envelopes do not roll over;
- no more than **2 envelopes per day**;
- one user;
- the storage shown in your plan, currently **15 MB**.

An "envelope" is one document package sent for signature, whatever the number of signers.

C3.2 **The free plan is not a commitment.** We may change, reduce, suspend or end the free plan or any
free feature or limit, at our discretion. We will give notice where practical, so you can download
your documents.

C3.3 **No charges on Free.** The free plan costs nothing. We will not charge you without your
separate agreement to a paid plan. The free plan is not a trial and does not convert into a paid plan
automatically. The Free plan does not include templates.

C3.4 **Standard (paid Personal plan).** You may upgrade your Personal account to **Standard**:
- **US $10 per month**, plus applicable taxes;
- **25 envelopes per month**, with no daily limit;
- 1 GB storage;
- a **12-month commitment, billed monthly**.

Before you buy, the checkout shows the price, taxes, the commitment, when and how the plan renews,
and how to cancel. You can cancel online from Settings. Cancellation takes effect at the end of the
commitment, and the account then returns to the Free plan.

## C4. Using the Service with a Personal account

Part A applies, including:
- A4: you decide whether e-signature is right for your document;
- A3.3: signers are verified by email only;
- A7: acceptable use;
- A8: enforcement.

The free plan does not include stronger identity checks; do not rely on it where you need them.

## C5. Grievances and reviews

C5.1 A person at Aramo can review any automated hold, limit or pause on request at
support@aramo.ai.

C5.2 **India:** see section D2 for the Grievance Officer.

## C6. Closing your Personal account

C6.1 **Closing it yourself.** You may close your account at any time from Settings. Sending stops
immediately. Requests you already sent stay open for their signers.

C6.2 **Download first.** After closing you cannot sign in or download. Download anything you want to
keep before you close.

C6.3 **What happens to your documents** *(corrected from 1.0 §12.3)*:
- when you close your account, your completed, declined and voided envelopes are **queued for
  permanent purge, including personal data (section A6.4(c)), and are purged after 14 days**;
- envelopes under a legal hold are kept;
- records we must keep by law are kept, as described in the Privacy Notice: accepted terms,
  security and abuse records, and the evidence summaries described in section A6.5;
- other parties keep the copies they received.


C6.4 **Closing by us.** We may close a free account under section A8, if we discontinue the free plan
(section C3.2), or after long inactivity with notice to the account email where practical.

C6.5 **Deletion requests.** At any time you can ask us to delete your data by emailing
privacy@aramo.ai (India: also grievance@aramo.ai). A person handles the request. We respond within
**30 days**, delete what we are not required to keep, and tell you what we keep and why.

## C7. Liability for Personal accounts

To the extent the law allows, Aramo's total liability to you for all claims relating to the Service
is limited to the greater of:
- **(a)** the amount you paid us in the 12 months before the claim;
- **(b)** **US $50** for US residents or **₹4,000** for India residents.

Section A12.3 applies.

---

# PART D — COUNTRY-SPECIFIC TERMS

## D1. United States

D1.1 Nothing in these Terms limits consumer rights under US state law that cannot be waived.

D1.2 For Business plans that renew automatically, we follow the applicable state automatic-renewal
laws, including clear disclosure, consent and an online cancellation method.

## D2. India

D2.1 **Electronic signatures under the Information Technology Act, 2000.**
- Only the electronic signatures recognized by that Act, such as a digital signature certificate or
  Aadhaar-based e-Sign, carry its statutory presumptions. **Aramo Sign's email-based signature is not
  one of those.**
- Electronic records and simple electronic signatures may still be evidence of an agreement under
  Indian contract and evidence law.
- Documents excluded by the Act's First Schedule, as amended, or that Indian law requires in a
  particular form, signature or registration, must not be signed with Aramo Sign.
- You are responsible for any stamp duty.

D2.2 **Consumer rights.** Individuals keep their rights under the Consumer Protection Act, 2019,
including the right to complain to the Consumer Disputes Redressal Commission with jurisdiction where
they live.

D2.3 **Governing law for India residents with a Personal account:** the laws of India; other disputes
are subject to the courts at **Chennai, Tamil Nadu**.

D2.4 **Grievance Officer** under the IT (Intermediary Guidelines and Digital Media Ethics Code)
Rules, 2021:
- Purush Pichaimuthu, grievance@aramo.ai, 5/180 Skylab Avenue, Chennai 600126, Tamil Nadu, India;
- acknowledges within **24 hours** and resolves within **15 days**;
- we act on unlawful content as those Rules require.


---

## Contact

- Support, abuse, security: support@aramo.ai
- Privacy: privacy@aramo.ai
- India grievances: grievance@aramo.ai
- Post: Astre Consulting Services Inc, 2909 Gettysburg Sq, Vienna, VA 22181, USA

---

