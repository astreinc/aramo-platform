# Aramo Sign — Electronic Records and Signature Consent Disclosure

| | |
|---|---|
| Document key | `sign.esign_consent_disclosure` |
| Version | 0.1.0 (served to signers as disclosure `v2` when enabled) |
| Status | **DRAFT — LEGAL-PENDING.** Not approved. Signers keep seeing disclosure `v1` until this text is approved and switched on (`ESIGN_DISCLOSURE_VERSION=v2`). |
| Baseline | `Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1-v1_0-LOCKED` §3.C |

## Text shown to the signer

The exact text below (between the rules) is what `libs/esign` serves as disclosure `v2`. A
test checks the two copies match, so the signer sees what legal review approved.

---

**Agreement to Use Electronic Records and Signatures**

By affirmatively selecting "I agree to use electronic records and signatures", you consent to using electronic records and signatures for the document transaction presented to you, where permitted by applicable law.

You acknowledge that:

1. The document will be presented electronically for your review.
2. Your electronic signature is intended to represent your agreement or other stated signing intention.
3. Electronic records may be made available to the document sender and other authorized parties.
4. You may access or obtain a copy of the signed document, subject to applicable access arrangements.
5. You may decline to sign electronically. Where applicable, the sender can explain available alternatives.
6. Instructions for withdrawing consent, requesting paper records and updating contact information will be provided where required.

---

## How consent is captured (implemented)

- The consent checkbox is **never preselected**. The signer must tick it before continuing.
- Before signing, the signer's page fetches the current disclosure (version, text and its SHA-256)
  from the server. The page sends back the version and hash it showed. The server refuses a version
  or hash it does not hold.
- Each acceptance is recorded as evidence with the disclosure version, the text hash, the
  envelope and signer it belongs to, the time, and the network address and browser the signer's
  device reported. It is also written to the envelope's hash-chained signing ledger.
- After completion the signer receives an email with a link to download the signed copy (valid for
  30 days by default), which supports item 4.

## Required legal review

- Whether US E-SIGN Act consumer-consent requirements apply to the intended transactions, and if so:
  hardware and software requirements, the right to paper copies and any fee, the withdrawal procedure
  and its consequences, and how to update contact details.
- Equivalent requirements for other intended jurisdictions (for example eIDAS in the EU).
- Transaction types excluded from electronic signature by law.
