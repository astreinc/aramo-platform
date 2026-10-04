<!--
Filed to doc/backlog by the Code Executor on PO instruction ("File the below backlog
directive in the doc/backlog. No execution.").
STATUS: BACKLOG — NOT implementation authorization.
Vocab-compliance note: a few email-example labels (section 9) and one purpose line
(section 4F) were reworded to avoid Tier-2 trust-vocabulary literals banned by
scripts/verify-vocabulary.sh, which the CI vocab guard enforces on every checked-in
path. Meaning is preserved and no substantive content changed from the PO's text.
-->

ARAMO — DOCUMENTS / TEMPLATE PRODUCTIZATION BACKLOG DIRECTIVE v1.0

STATUS
BACKLOG

PURPOSE

Record the future document/template families Aramo intends to productize
after the Right-to-Represent (RTR) template-driven vertical.

This directive is NOT implementation authorization.

It exists to preserve the product/architecture direction so future work
extends the existing Documents + Native E-Sign substrate instead of
creating independent document systems.

======================================================================
1. ARCHITECTURE PRINCIPLE
======================================================================

Aramo has one canonical Documents bounded context.

Future document families should reuse, where applicable:

DocumentType
Document
DocumentRevision
DocumentArtifact
DocumentAssociation
DocumentTemplate
TemplateVersion
TemplateFieldDefinition
DocumentRequirement
DocumentPacket
Native E-Sign

Do not create a separate template engine per business workflow.

Workflow domains remain authoritative for their own business states.

Documents owns documentary state and evidence.

E-Sign owns signature/execution evidence.

======================================================================
2. PLATFORM VS TENANT OWNERSHIP
======================================================================

Platform defines:

- canonical document type
- allowed execution mode
- valid association/resource semantics
- permitted binding categories
- security/compliance invariants
- workflow integration contract

Tenant controls, where permitted:

- template wording/content
- active template version
- branding
- permitted tenant-specific fields
- later, client-specific variants

A tenant template must not redefine workflow authority.

======================================================================
3. ALREADY PRODUCTIZED
======================================================================

RIGHT_TO_REPRESENT

Status:
FIRST TEMPLATE-DRIVEN DOCUMENT VERTICAL.

Target architecture:

Tenant active RTR template
-> server-side binding
-> frozen document revision
-> recruiter preview
-> Native E-Sign
-> executed evidence
-> RTR readiness
-> Submittal eligibility

This vertical is the reference implementation for later document families.

======================================================================
4. FUTURE DOCUMENT/TEMPLATE FAMILIES
======================================================================

----------------------------------------------------------------------
A. OFFER LETTER
----------------------------------------------------------------------

Purpose:
Formal employment/placement offer to Talent.

Ownership:
Offer domain owns Offer lifecycle.
Documents owns generated/executed document.
E-Sign owns execution evidence.

Future work:

- tenant-managed Offer Letter templates
- version pinning
- server-authoritative bindings
- preview before send
- existing Native E-Sign
- executed offer + certificate
- later support for Offer acceptance policy

Do not allow document execution itself to silently transition Offer state.

Priority:
HIGH

----------------------------------------------------------------------
B. EMPLOYMENT AGREEMENT
----------------------------------------------------------------------

Purpose:
Formal employment agreement for workers employed by the tenant or an
applicable employing organization.

Potential bindings:

- Talent
- Requisition
- Placement
- employer/tenant organization
- start date
- approved compensation terms

Future capabilities:

- tenant-managed template
- preview
- signature
- executed-document evidence
- possible pre-start/onboarding requirement

Priority:
HIGH / MEDIUM

----------------------------------------------------------------------
C. CONTRACTOR / CONSULTANT AGREEMENT
----------------------------------------------------------------------

Purpose:
Agreement governing contractor/consultant engagement.

Potential context:

Talent
Placement
Requisition
Tenant organization
Client where appropriate

Possible future requirement for contract placements.

Priority:
MEDIUM

----------------------------------------------------------------------
D. NDA / CONFIDENTIALITY AGREEMENT
----------------------------------------------------------------------

Purpose:
Talent, contractor, employee, or client confidentiality agreement.

Possible scope:

tenant-wide
client-specific
requisition/engagement-specific

May require SINGLE_SIGNATURE or MULTI_SIGNATURE depending on document.

Priority:
MEDIUM

----------------------------------------------------------------------
E. ASSIGNMENT CONFIRMATION
----------------------------------------------------------------------

Purpose:
Confirm a worker's assignment after placement.

Potential bindings:

Talent
Placement
Requisition
Client
start date
location
approved commercial/employment terms

Placement remains authoritative for placement state.

Priority:
MEDIUM

----------------------------------------------------------------------
F. CLIENT DISCLOSURE / CONSENT / ACKNOWLEDGEMENT
----------------------------------------------------------------------

Purpose:
Client-required disclosure, acknowledgement, or consent that must be
completed before submittal, interview, onboarding, or placement.

Future design must determine whether requirement is attached to:

Talent
Talent x Requisition
Submittal
Placement

Do not make Documents determine eligibility itself.

Priority:
MEDIUM

----------------------------------------------------------------------
G. POLICY / HANDBOOK / IP ACKNOWLEDGEMENT
----------------------------------------------------------------------

Purpose:
Employee/worker acknowledgements such as:

- employee handbook
- acceptable-use policy
- information-security policy
- IP/invention assignment acknowledgement
- code of conduct

Likely requirement/evidence documents around onboarding.

Priority:
MEDIUM / LATER

----------------------------------------------------------------------
H. PURCHASE ORDER DOCUMENTS
----------------------------------------------------------------------

Potential document families:

- Purchase Order
- PO acknowledgement
- PO amendment
- extension/change document

Potential context:

Client
Requisition
Placement
Purchase Order

The commercial/PO domain remains authority for PO business state.

Priority:
LATER

----------------------------------------------------------------------
I. STATEMENT OF WORK (SOW)
----------------------------------------------------------------------

Purpose:
Client commercial/service agreement.

Likely associations:

COMPANY / CLIENT
TENANT_ORGANIZATION / ISSUER
possibly Requisition, Placement, or project context

Likely MULTI_SIGNATURE in some cases.

Priority:
LATER

----------------------------------------------------------------------
J. MASTER SERVICE AGREEMENT (MSA)
----------------------------------------------------------------------

Purpose:
Organization-level governing agreement with a client.

Likely context:

Tenant organization
Client Company

Not Talent-specific.

Must demonstrate that canonical Documents remains generic beyond
recruiting documents.

Priority:
LATER

----------------------------------------------------------------------
K. BUSINESS INSURANCE / CERTIFICATE OF INSURANCE
----------------------------------------------------------------------

Purpose:
Store and, where appropriate, require client/business insurance evidence.

Typically uploaded authoritative external evidence rather than generated
content.

Possible associations:

Company
Tenant organization
Client relationship

Priority:
LATER

----------------------------------------------------------------------
L. CLIENT-SPECIFIC DOCUMENT / FORM / PDF
----------------------------------------------------------------------

Purpose:
Allow tenant administrators to configure documents required by a
particular client.

Examples:

- client representation agreement
- client-specific disclosure
- onboarding form
- compliance acknowledgement
- client questionnaire/form
- uploaded PDF requiring signatures

Future template resolution may support:

client-specific template
-> tenant default template

but precedence must be explicitly designed and governed.

Priority:
HIGH after tenant template administration exists.

----------------------------------------------------------------------
M. START / PRE-START / ONBOARDING DOCUMENTS
----------------------------------------------------------------------

Potential future documents:

- start confirmation
- onboarding acknowledgement
- policy acknowledgement
- employment forms
- assignment/start instructions
- client onboarding documentation

These may become DocumentRequirements against Placement or another
appropriate workflow authority.

Priority:
LATER

======================================================================
5. EXISTING TALENT DOCUMENT TYPES
======================================================================

Existing SYSTEM Talent document classifications include:

TALENT_RESUME
TALENT_COVER_LETTER
TALENT_CERTIFICATION
TALENT_WORK_SAMPLE
TALENT_REFERENCE_LETTER
TALENT_OTHER

These currently represent primarily uploaded/document classifications.

Do NOT automatically convert all of them into generated templates.

Any future generated-template use must have a concrete product need.

======================================================================
6. FUTURE TENANT ADMIN SURFACE
======================================================================

Planned location:

Tenant Console
-> Settings
-> Documents
-> Templates

Possible future capabilities:

- list supported document types
- see active template/version
- create draft version
- preview
- activate
- retire
- inspect binding variables
- upload PDF templates where supported
- configure tenant branding
- later client-specific overrides

Recruiters and operational users should consume governed templates;
they should not become template designers.

======================================================================
7. EXPECTED PRODUCTIZATION ORDER
======================================================================

Recommended sequence:

1. Right to Represent
   COMPLETE / REFERENCE IMPLEMENTATION

2. Tenant Document Template Administration

3. Offer Letter

4. Client-specific documents

5. Employment / Contractor agreements

6. NDA / confidentiality

7. Assignment confirmation

8. onboarding/compliance acknowledgements

9. MSA / SOW / PO / insurance and wider business documents

Sequence can change according to product demand.

======================================================================
8. FUTURE CROSS-CUTTING CAPABILITIES
======================================================================

Introduce only when concrete document families require them:

- client-specific template precedence
- branding/header/footer
- uploaded PDF template authoring
- richer field types
- repeating sections/tables
- multi-signer routing
- conditional content
- DocumentPacket productization
- requirement administration UI
- tenant-managed storage
- retention/legal hold
- enterprise PDF engine adapter

Do not implement these speculatively.

======================================================================
9. EXPLICITLY OUT OF THIS BACKLOG
======================================================================

EMAIL TEMPLATES ARE NOT DOCUMENT TEMPLATES.

Do not implement recruiter/client-facing communication templates inside
libs/documents or DocumentTemplate.

Email templates belong to the Communications bounded context.

Examples excluded here (email families, not document templates):

- talent-sourcing email
- requisition contact email
- interview email
- client-send (submittal) email
- reminder email
- onboarding communication email

Those are governed by the separate Communications Email Template
directive.

======================================================================
10. BACKLOG TRIGGER
======================================================================

A document family should leave this backlog only when there is a concrete
workflow/product use case.

At that point:

1. recon the current workflow
2. identify authoritative domain data
3. determine associations
4. determine signature/execution mode
5. determine requirement/gating semantics if any
6. define the minimal binding catalog
7. prototype user experience
8. issue a narrow implementation directive

Do not implement the entire backlog as one program.
