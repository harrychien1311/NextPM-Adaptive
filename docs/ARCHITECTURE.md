# Architecture

## Request flow

```
React (Vite)                Express API                     PostgreSQL
─────────────               ─────────────                   ──────────
TanStack Query   ──HTTP──►  routes (Zod validate)
                            └─► service (business rules)  ──Prisma──►  tables
                                 ├─► ai/provider.ts  ──HTTPS──► Anthropic API
                                 └─► audit/logEvent  (every decision recorded)
```

Routes only validate and delegate. Services own the invariants. There is no deterministic rule
engine — every recommendation, analysis and document draft is an LLM call, made through
`ai/provider.ts`, which is the only file that talks to a model.

## The model calls

`ai/provider.ts` holds one prompt per job. They are never combined: each fires at a different point
in the flow, on a different button.

| Call | Fires on | Mock fallback |
| --- | --- | --- |
| `analyzePlanningNeeds()` | *Analyze planning needs* — **the current main path** | **none** |
| `generateDocument()` / `generateGovernanceArtifact()` | *Generate document* | yes |
| `fillTemplatePlaceholders()` | generating a document backed by a customer template | yes |
| `assessChecklistItems()` | *Assess readiness*, and again when a document is approved | **none** |
| `translateChecklistItems()` | uploading a customer checklist | **none** |
| `translateGapQuestions()` | `npm run db:fix:gap-language`, a one-off repair | **none** |
| `answerAgentQuestion()` | the planning-agent chat | no (returns an error) |
| `extractInputValues()` | legacy `POST /input/verify` — no UI calls it | **none** |
| `recommendGovernanceModel()` | legacy `POST /approach/evaluate` — no UI calls it | yes |

**"No mock fallback" is a design decision, not an omission.** Where a wrong answer is worse than no
answer — an invented planning gap, a guessed "MET" on a customer requirement, a fabricated
translation of a contractual check — the call throws and the screen says so. Where a plausible
draft is still useful without a key, the deterministic writer stands in, and
`AiApproachSuggestion.aiProvider` records which one produced the result so a keyword heuristic and a
real recommendation are never confused.

### Analyze planning needs — one call, four answers

Project Input used to have two AI buttons: *Verify input* (reading documents into the form field by
field) and *Suggest governance model*. Both are gone. One call now reads every uploaded document
plus what the PM typed and returns, in a single pass:

| Part | Feeds |
| --- | --- |
| `overview[]` | the Planning Review top panel — what the project *is* |
| `approaches[]` | the Approach Advisory, scored on nine weighted criteria with the breakdown |
| `planningGaps[]` | the Planning Gaps panel, **and** the Studio's document filter via `documentName` |
| `findings[]` | Risks & limitations — contradictions *between* documents, each quoting both sides |
| `customer` | the customer proposal banner — still a proposal, never applied |

`Project.preferredApproach` decides the whole shape of the answer and nothing else does. Null runs
the recommend prompt (four models, each with reasons *and* evidence, switchable on screen); a value
runs the assess prompt (that model only, scored, reasons but **no evidence** — the PM is not being
sold a decision they already made). The server enforces the shape rather than trusting the prompt.

Documents are read whole, so the cost is driven by their size: a Korean SOW runs about 1.8
characters per token against roughly 4 for English, which is the single largest factor in what one
analysis costs.

## Module boundaries

| Module | Owns |
| --- | --- |
| `auth` | credentials, JWT issuing, role checks |
| `admin` | account administration (create / role / reset password / deactivate / delete) — administrator-only, and the only place a role is assigned |
| `program` | program + project hierarchy, project provisioning, per-user access, readiness computation |
| `input` | input values, references, action resolution, domain readiness |
| `rules` | the analysis snapshot, approach options, the PM decision gate — keeps its original folder name from when it held a rule engine, but is LLM-driven now |
| `documents` | catalog, templates, generation contract, drafting, approval, Office export |
| `customer` | the customer reference library — customers, their checklists and their document templates |
| `checklist` | scoring one project against its customer's checklist |
| `dashboard` | read-only aggregation for the control center |
| `agent` | chat threads + advisory replies |
| `audit` | append-only event log |
| `ai` | the only place that talks to a model |

`rules.service` calls `documents.service` (after a decision, provision the pack). **The reverse
never happens.** That rule is why `gapDocumentNames` — which reads the analysis snapshot to decide
which documents the Studio shows — lives in `documents.service` rather than in `rules.service`
where its subject matter would suggest: importing back would create the one module cycle this
codebase does not have.

## Invariants enforced server-side

1. **A document never becomes an approved fact on its own.** Extraction produces candidates; the PM
   accepts them. This is what the `source` enum and `customerSuggestion` exist for. (A value the PM
   types is verified on save — there is no second person to confirm it to.)
2. **No generation before the decision gate.** `generateDraft` refuses without an active
   `ApproachDecision`.
3. **Required blockers block.** An open `ActionItem` with `priority = REQUIRED` and
   `blocksDocument = X` prevents generating X.
4. **The model never invents a missing fact.** Every drafting prompt forbids inventing a date, name,
   number, owner or placeholder; an unknown becomes a `{{gap:N}}` token plus a PM question, and
   only answered tokens are ever substituted.
5. **Approval is a distinct step.** Generation ends at `PM_REVIEW`; only an explicit approve call
   sets `APPROVED`, stamping `approvedById` and `approvedAt`.
6. **Overrides need a reason.** `outcome = OVERRIDDEN` without a rationale is a 400.
7. **Exports carry approved content only.** Drafts and unresolved values are excluded from the
   approved-baseline export; the per-document Office / dashboard `.html` downloads are working
   drafts and sit outside that policy.
8. **Everything is traceable.** Analyses, generations, approvals and exports all write an
   `AuditEvent` with actor and payload.
9. **Workspace access is proven per request.** Every `:projectId` router mounts
   `requireProjectMember`, which admits only the program owner, the project's owner, or a
   `ProjectMember` row — administrators included in the refusal. Write routes additionally run
   `requireProjectRole`, so a `MEMBER` is answered 403 whatever the client renders.
10. **Privilege is only granted by an administrator.** `auth.service.register` hard-codes
    `PROJECT_OWNER` and ignores any role in the request body; `PROGRAM_OWNER` and `ADMIN` exist
    only through the admin console.

## Two cross-cutting rules

**The interface is English; the evidence is bilingual.** Uploads are routinely Korean or
Vietnamese and the PM is not required to be. Every prompt that produces text a human reads on
screen writes English. Where the point is traceability — governance evidence, checklist items — the
source sentence is kept *beside* the English, never instead of it: a translation cannot be searched
for in a Korean PDF. Proper nouns keep the spelling their document uses.

**The UI locks what a reader cannot do, and says why.** `GET /projects/:id` returns the viewer's own
`projectRole`; `useReadOnlyGuard` turns it into a frozen control that stays clickable and answers
with a toast. A plain `disabled` attribute fires no click event and so can never explain itself.
This is presentation only — the server enforces the same rule independently.

## Readiness maths

- *Input readiness* = `(filled + verified) / (allFields × 2)`. Scored over every field of the
  project type.
- *Domain readiness* = share of that domain's inputs which are filled **and** verified.
- *Project readiness* — the Ready-to-Start ring — is **the customer's own standard plus the
  approved planning outputs**, 60/40, as soon as that customer's checklist has been assessed. Input
  readiness is deliberately not in it: how full our intake form is is our administration, not
  evidence that the project can start. `projectReadiness` returns a `basis` naming which of four
  formulas produced the number, and the dashboard prints it under the verdict:

  | `basis` | Formula | When |
  | --- | --- | --- |
  | `CUSTOMER_AND_OUTPUTS` | 60% customer standard + 40% approved outputs | checklist assessed, documents exist |
  | `CUSTOMER` | customer standard alone | checklist assessed, no document pack yet |
  | `INPUT_AND_OUTPUTS` | 50% input readiness + 50% approved outputs | no checklist for this customer |
  | `INPUT` | input readiness alone | no checklist, nothing generated |

  The last two are a fallback, not a second opinion: most customers have no checklist in the
  library, and scoring those projects on approved documents alone would tell a PM who has just
  filled in a careful profile that they are at 0%.
- *Delivery readiness* = unweighted mean over active projects; program roll-up is the same.

## Scaling notes

- Analysis snapshots (`AiApproachSuggestion`) are append-only, so one can always be replayed as it
  stood when the PM decided.
- Generation is synchronous today. For long documents, move `generateDraft` behind a queue
  (BullMQ + Redis): the `GENERATING` status already exists for that transition.
- Office exports are rendered on demand from the database on every download — nothing is cached or
  persisted to disk. If that becomes hot, cache the rendered buffer per document version.
- The dashboard is several aggregates in one round trip; if it becomes hot, cache per project and
  invalidate on any `AuditEvent` write.
- **There is no prompt caching anywhere.** Every chat question re-sends the whole project context at
  full input price, and that context grows as documents are generated. A `cache_control` breakpoint
  on the project block is the single largest cost saving available.
