ARAMO BACKLOG DIRECTIVE
VMS ↔ ARAMO CANONICAL REQUISITION + LIFECYCLE MAPPING
DRAFT FOR CANONICAL BACKLOG

STATUS
BACKLOG / ARCHITECTURE-FIRST / IMPLEMENTATION DEFERRED UNTIL CONNECTOR NEED

PRIORITY
MEDIUM

WHY THIS EXISTS

Aramo is intended to integrate with external Vendor Management Systems (VMS)
such as SAP Fieldglass, Beeline, and similar staffing/procurement platforms.

Client-side hiring managers may operate primarily in their VMS rather than
directly in the Aramo ATS.

Therefore the important integration problem is not "replicate the client's VMS
inside Aramo."

The important problem is:

1. ingest external requisition/job data,
2. translate it into Aramo's canonical Requisition model,
3. translate external lifecycle/status changes into canonical Aramo lifecycle
   actions,
4. synchronize downstream staffing events such as submittals, interviews,
   decisions, offers, placements, and assignments where supported,
5. preserve provenance, idempotency, tenant isolation, and domain authority.

This directive defines the mapping architecture and the future recon/documentation
work required before broadening VMS integrations.

================================================================
1. CORE ARCHITECTURAL PRINCIPLE
================================================================

External VMS data is NOT Aramo domain truth merely because it arrived from a VMS.

Use:

VMS-specific representation
        ↓
Connector / translation adapter
        ↓
Canonical Aramo model
        ↓
Aramo domain authority

Do not leak vendor-specific lifecycle/status vocabulary into canonical Aramo
domain state.

Each VMS connector must translate its external vocabulary into Aramo-owned
canonical concepts.

================================================================
2. SCOPE
================================================================

This directive covers BOTH:

A. REQUISITION FIELD MAPPING
B. REQUISITION LIFECYCLE / STATUS MAPPING

and the related downstream integration seams required to keep those mappings
coherent.

This directive does NOT require implementation now.

First priority is repository recon + canonical mapping documentation.

================================================================
3. REQUISITION FIELD MAPPING
================================================================

For each supported VMS, inventory every inbound requisition/job field and map it
to one of:

1. canonical Aramo Requisition field
2. canonical Company / Contact / Commercial / Requirement field
3. external-source metadata
4. connector-only staging field
5. unsupported / intentionally ignored
6. requires product ruling

Examples to inspect:

External requisition/job ID
Client / company
Hiring manager
Job title
Job description
Openings
Location
Work arrangement
Start date
End date
Employment type
Contract duration
Bill rate
Pay rate
Rate ceiling
Currency
Skills / requirements
Work authorization
Education
Experience
Priority
Department / cost center
Business unit
Reason for opening
VMS owner/contact
Supplier instructions
Attachments
Custom fields
Compliance attributes
Submittal limits
Interview instructions

Do NOT assume these exact mappings exist.

Fresh-read connector code and contracts.

================================================================
4. CANONICAL FIELD-MAPPING OUTPUT
================================================================

Produce a canonical table per connector:

| External field | External meaning | Aramo target | Transform | Required? | Direction | Authority | Notes |

Possible Direction values:

INBOUND
OUTBOUND
BIDIRECTIONAL
READ-ONLY
NOT SUPPORTED

Possible Authority values:

VMS AUTHORITATIVE
ARAMO AUTHORITATIVE
SHARED / RECONCILED
IMPORT-ONLY
DERIVED

================================================================
5. LIFECYCLE / STATUS MAPPING
================================================================

Aramo owns its canonical requisition lifecycle.

Current canonical values must be fresh-read from the live repository before any
mapping is written.

External VMS statuses must translate through an adapter.

Pattern:

VMS status/event
      ↓
connector translation
      ↓
canonical Aramo lifecycle action
      ↓
Aramo transition policy
      ↓
canonical state

Do NOT directly persist vendor statuses into the canonical requisition status
column.

================================================================
6. STATUS MAPPING OUTPUT
================================================================

For each VMS, produce:

| External status/event | External semantics | Canonical Aramo action/state | Exact/approximate | Reversible? | Conflict rule | Notes |

The mapping must distinguish:

- exact semantic match
- approximate translation
- no canonical equivalent
- informational only
- requires local policy decision
- ignored

Examples requiring careful analysis:

OPEN
PUBLISHED
RELEASED
ON HOLD
CLOSED
FILLED
CANCELLED
EXPIRED
PAUSED
CLOSED TO SUBMITTALS
AWARDED
WORK ORDER CREATED

Do NOT equate "Filled" with any Aramo status without repo/product evidence.

Capacity fulfillment may be derived and separate from lifecycle state.

================================================================
7. LIFECYCLE AUTHORITY
================================================================

For each mapped external lifecycle event determine:

- who is authoritative?
- does external VMS state force Aramo state?
- does Aramo evaluate the transition through its own policy?
- can Aramo refuse an external transition?
- is override supported?
- is local state allowed to diverge?
- how are conflicts surfaced?
- what is recorded in audit/provenance?

Preferred architecture:

external command
      ↓
translation
      ↓
explicit canonical action
      ↓
Aramo policy adjudication
      ↓
commit or reject
      ↓
integration result / exception

Do not create a "blind mirror" of VMS state.

================================================================
8. EXTERNAL IDENTITY / PROVENANCE
================================================================

Every mapped requisition must retain sufficient source identity, including where
available:

- VMS/provider
- tenant
- external requisition/job ID
- external revision/version
- source timestamps
- source event ID
- source account/client identity
- ingestion correlation ID

Mappings must be idempotent.

Repeated delivery of the same external event must not create duplicate
requisitions or duplicate lifecycle transitions.

================================================================
9. UPDATE / RECONCILIATION RULES
================================================================

Document what happens when the VMS changes a requisition after initial import.

Examples:

- title changes
- openings change
- rate changes
- start/end dates change
- hiring manager changes
- status changes
- requisition is canceled
- custom field changes

For every mapped field classify:

VMS-WINS
ARAMO-WINS
MERGE / RECONCILE
MANUAL REVIEW
IMMUTABLE AFTER CREATE
DERIVED

No silent overwrite of Aramo-owned business state.

================================================================
10. DOWNSTREAM STAFFING MAPPINGS
================================================================

Inventory whether existing connectors map or sync:

- talent submittal
- submittal status
- interview request
- interview scheduling
- interview feedback
- client decision
- rejection
- offer
- work order
- placement
- assignment
- start
- end
- extension
- cancellation

For each, determine:

external concept
      ↔
canonical Aramo domain owner

Examples:

VMS submittal
      ↔
Submittal

VMS interview
      ↔
InterviewSession

VMS client decision
      ↔
ClientSelection

VMS work order / placement
      ↔
Placement / Assignment

Do not create connector-owned shadow lifecycle models when canonical Aramo
domains already exist.

================================================================
11. INBOUND VS OUTBOUND
================================================================

Document separately:

INBOUND
VMS → Aramo

OUTBOUND
Aramo → VMS

Do not assume symmetry.

A field may be inbound-only while another may be bidirectional.

================================================================
12. CONNECTOR-SPECIFIC ADAPTERS
================================================================

Each VMS gets its own adapter.

Example target shape:

Fieldglass adapter
Beeline adapter
Other future VMS adapters

        ↓

Canonical connector contract

        ↓

Aramo domains

Vendor-specific vocabulary, status codes, and field peculiarities stay in the
adapter.

================================================================
13. ERROR / EXCEPTION HANDLING
================================================================

Document behavior for:

- unknown status
- missing required field
- unsupported field
- invalid transition
- stale external version
- duplicate event
- bad tenant mapping
- missing company/contact
- deleted external requisition
- late/out-of-order events
- connector outage
- partial failure

Exceptions should be visible to Aramo operators/account managers where action is
required.

Do not silently discard important synchronization failures.

================================================================
14. TENANT / CLIENT BOUNDARIES
================================================================

Every connector action must preserve:

- tenant isolation
- correct client/company association
- correct contact association
- authenticated connector identity
- source provenance
- field-level authorization where applicable

Never trust tenant/company IDs supplied externally without mapping/validation.

================================================================
15. AUDIT / TRACEABILITY
================================================================

For every inbound/outbound lifecycle mutation, preserve enough evidence to answer:

- which VMS caused this?
- which external object/event?
- when?
- what mapping rule applied?
- what Aramo state existed before?
- what state resulted?
- was policy invoked?
- was the event accepted, rejected, overridden, or ignored?

================================================================
16. CURRENT-STATE RECON REQUIRED
================================================================

Before implementing new mapping work, recon the repo and report:

1. all existing VMS/integration connectors
2. Fieldglass-specific implementation if present
3. all current inbound requisition mappings
4. all current outbound mappings
5. lifecycle translation code
6. external IDs / source reference models
7. event/idempotency strategy
8. retry strategy
9. reconciliation behavior
10. connector-owned tables
11. policy / transition entry points
12. existing Pact/OpenAPI contracts
13. known VMS-specific assumptions
14. current tests and gaps

================================================================
17. REQUIRED DOCUMENT ARTIFACT
================================================================

Produce ONE canonical VMS mapping document with sections:

A. Canonical Requisition model
B. Canonical lifecycle
C. Fieldglass mapping
D. Beeline mapping
E. Future connector template
F. Inbound mappings
G. Outbound mappings
H. Status/lifecycle crosswalk
I. Conflict/reconciliation rules
J. Idempotency/provenance
K. Error handling
L. Known gaps / product rulings

Do not scatter mappings across unrelated docs.

================================================================
18. NON-GOALS
================================================================

This directive does NOT authorize:

- redesigning Requisition
- adding new canonical statuses casually
- copying VMS schemas directly into Aramo
- building a generic workflow engine
- building a Client Portal
- introducing new client-facing UX
- auto-accepting every VMS transition
- bypassing Aramo lifecycle policy
- coupling canonical domain models to Fieldglass/Beeline terminology

================================================================
19. TRIGGER FOR IMPLEMENTATION
================================================================

Move from documentation/recon to implementation when one of these becomes true:

1. a new VMS connector is being built,
2. existing Fieldglass/Beeline behavior is incomplete or inconsistent,
3. a client requires bidirectional synchronization,
4. status mapping bugs appear,
5. duplicate/out-of-order event handling becomes operationally significant,
6. connector-specific logic begins leaking into canonical domain code.

================================================================
20. ACCEPTANCE PRINCIPLE
================================================================

The architecture is correct when:

VMS-specific data
      ↓
clean adapter translation
      ↓
canonical Aramo model
      ↓
Aramo policy + authority
      ↓
traceable synchronized state

not:

VMS status/value
      ↓
copied directly into Aramo truth
