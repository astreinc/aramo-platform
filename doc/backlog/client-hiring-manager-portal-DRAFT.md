ARAMO BACKLOG DIRECTIVE
CLIENT / HIRING MANAGER PORTAL
DRAFT FOR CANONICAL BACKLOG

STATUS
BACKLOG / DEMAND-DRIVEN

PRIORITY
LOW

WHY THIS EXISTS

Aramo's primary ATS users are staffing-company users:

- recruiters
- account managers
- recruiting/delivery leadership
- operations
- commercial/back-office users

For many enterprise clients, hiring managers already work in an external VMS
such as Fieldglass or Beeline.

Therefore Aramo should NOT build a broad client/hiring-manager portal merely to
duplicate an existing VMS.

This directive preserves the option to build a lightweight client-facing portal
when a real client/use case requires it.

================================================================
1. PRODUCT PRINCIPLE
================================================================

If the client already uses a VMS:

    Client / Hiring Manager
            ↓
           VMS

    Staffing company users
            ↓
         Aramo ATS

Aramo integrates with the VMS.

If the client does NOT use a VMS, Aramo may provide a client portal.

================================================================
2. TRIGGER FOR BUILD
================================================================

Do not implement this portal until one or more of the following is true:

1. a client without a VMS needs client-side collaboration,
2. a client explicitly wants Aramo instead of its existing VMS for selected
   workflows,
3. VMS integration cannot support required client interaction,
4. a strategic product decision is made to offer Aramo as a lightweight client
   review portal,
5. multiple clients request the same client-facing workflow.

================================================================
3. POSSIBLE FUTURE SCOPE
================================================================

Potential client/hiring-manager capabilities may include:

- view assigned requisitions
- view submitted talent
- review resume/profile
- provide structured feedback
- accept/reject submittal
- request interview
- review interview schedule
- submit interview feedback
- make client selection / disposition
- review offer-related information where appropriate
- view placement/pre-start status where authorized
- add client notes/comments
- upload client documents
- receive notifications

These are potential capabilities only.

Do not treat this list as current committed scope.

================================================================
4. CLIENT PORTAL IS NOT ATS ACCESS
================================================================

Do not expose the normal tenant ATS console to client users.

Prefer a separate client-facing application / bounded surface with:

- explicit client identity
- narrow scopes
- resource-level access
- requisition/submittal-specific visibility
- no broad tenant search
- no internal recruiter notes
- no confidential internal commercial data
- no internal trust/evidence administration
- no staffing-company-only workflow controls

================================================================
5. AUTHORITY MODEL
================================================================

Client actions should map into existing Aramo domain authority.

Examples:

Client rejects talent
    ↓
ClientSelection / canonical client-decision workflow

Client requests interview
    ↓
Interview workflow / InterviewSession

Client provides feedback
    ↓
authorized feedback domain/event

Client accepts submittal
    ↓
canonical client-selection state

Do not create portal-only shadow state.

================================================================
6. VMS COEXISTENCE
================================================================

If both a VMS and Client Portal exist for the same client, authority must be
explicit.

For every action determine:

VMS AUTHORITATIVE
PORTAL AUTHORITATIVE
ARAMO AUTHORITATIVE
READ-ONLY
NOT AVAILABLE

Do not allow two uncontrolled client-facing sources to mutate the same domain
state.

================================================================
7. CLIENT CONTACT / HIRING MANAGER IDENTITY
================================================================

Future portal design must define:

- how Client Contact maps to portal identity
- which company/client they belong to
- which requisitions they can see
- whether access is assignment-based
- whether multiple contacts can collaborate
- invitation lifecycle
- authentication
- MFA / SSO
- revocation
- tenant/client boundary enforcement

Do not assume an Aramo tenant user account is appropriate for a client contact.

================================================================
8. MINIMUM ACCESS MODEL
================================================================

A portal user should see only explicitly authorized client resources.

Potential boundaries:

- client/company
- requisition
- submittal
- interview
- document
- feedback
- selection

No implicit broad access.

================================================================
9. DATA VISIBILITY
================================================================

Explicitly classify fields as:

CLIENT-VISIBLE
INTERNAL-ONLY
CONDITIONAL
REDACTED

Likely internal-only examples may include:

- recruiter/internal notes
- internal margin planning
- internal pay/bill calculations not contractually client-visible
- trust/evidence internals
- identity reconciliation internals
- internal operational exceptions
- internal agent reasoning

Fresh-read actual domains before making final classifications.

================================================================
10. UX PRINCIPLE
================================================================

Client portal UX should be lightweight.

Primary questions:

- What roles are waiting on me?
- Which talent should I review?
- What interviews require action?
- What feedback do I owe?
- What decisions are pending?

Do not replicate the full ATS navigation.

================================================================
11. POSSIBLE HOME VIEW
================================================================

A future client home could show:

Needs your attention
Pending talent reviews
Upcoming interviews
Feedback due
Recent submittals
Recent decisions

This is conceptual only.

================================================================
12. CLIENT REQUISITION VIEW
================================================================

Potential client requisition view:

- title
- approved job summary
- openings
- location
- relevant dates
- recruiter/account-manager contact
- submitted talent
- interview status
- feedback/decision actions

Do not expose internal sourcing/pipeline mechanics unnecessarily.

================================================================
13. SUBMITTAL REVIEW
================================================================

Potential review surface:

- talent summary
- resume
- submitted role fit/context
- authorized documents
- interview history if applicable
- structured feedback
- decision CTA

Client review should write into canonical Aramo domains.

================================================================
14. INTERVIEW FEEDBACK
================================================================

Potential future capability:

- interview participant
- interview round/type
- feedback form
- qualitative comments
- structured decision
- confirmation state

Do not invent independent portal interview state.

InterviewSession remains canonical authority.

================================================================
15. NOTIFICATIONS
================================================================

Possible future channels:

- email
- portal inbox
- meeting notification
- secure links

Do not implement until identity and permission model is established.

================================================================
16. SECURITY REQUIREMENTS
================================================================

Future client portal must preserve:

- strict client/company isolation
- explicit resource authorization
- no tenant-internal data leakage
- narrow scopes
- revocable access
- immutable/auditable consequential decisions
- no trust of resource IDs from browser alone
- server-side ownership/access validation

================================================================
17. AUDIT
================================================================

Client actions must be traceable to:

- portal user
- client/company
- requisition
- talent/submittal/interview as applicable
- action
- timestamp
- source = client portal

================================================================
18. NON-GOALS
================================================================

Do NOT build this merely to match a competitor.

Do NOT duplicate:

- Fieldglass
- Beeline
- other VMS systems

Do NOT expose the full ATS to client users.

Do NOT create portal-specific domain truth.

Do NOT prioritize this ahead of core recruiter/account-manager workflows or VMS
integration unless client demand justifies it.

================================================================
19. RELATIONSHIP TO VMS DIRECTIVE
================================================================

The VMS mapping directive has higher priority.

Preferred order:

1. canonical VMS/requisition/lifecycle mapping
2. robust VMS synchronization
3. identify genuine client interaction gaps
4. build portal only where those gaps remain or where no VMS exists

================================================================
20. FUTURE RECON BEFORE BUILD
================================================================

Before implementing a Client Portal, perform a fresh repo recon covering:

- current portal infrastructure
- portal identity model
- client Contact model
- client/requisition association
- submittal visibility
- InterviewSession visibility
- document visibility
- client-selection authority
- notification infrastructure
- audit/event seams
- existing reusable portal components
- any existing VMS/client decision overlap

================================================================
21. ACCEPTANCE PRINCIPLE
================================================================

Build the portal only when it clearly removes friction for a client that cannot
or should not perform the same workflow through an existing VMS.

The portal should be:

small
secure
client-specific
action-oriented
domain-backed

not:

a second ATS
a replacement for every VMS
a parallel source of truth
