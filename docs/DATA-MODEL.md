# Data model

See `backend/prisma/schema.prisma` for field detail. Grouped by responsibility below.

## Identity and hierarchy

```
Program ──has──► Project ──has──► ProjectMember ──► User
   └──── standalone (programId = null) ────┘
User ──owns──► Program, Project
```

- `Program.key` is a globally unique slug used by the UI for filtering.
- `Project.programId` is nullable: a null value means a standalone project.
- `Project.ownerId` is the account that created the workspace — it is what grants access, together
  with `ProjectMember`.
- Two independent role enums. `Role` (on `User`) is the account role: `ADMIN` administers accounts
  and nothing else, `PROGRAM_OWNER` creates programs and projects and may open every workspace,
  `PROJECT_OWNER` creates projects and may open only its own. `ProjectRole` (on `ProjectMember`)
  is the role *inside* one project: `OWNER` writes, `MEMBER` / `VIEWER` read. Keeping them apart
  means granting someone a workspace can never widen what they may do platform-wide.

Three fields on `Project` carry more weight than their size suggests:

| Field | Why it matters |
| --- | --- |
| `customer` | free text, and the **only** thing the customer library matches on. It decides which checklist scores the project and whose kickoff template gets filled. Set by the PM — never by extraction |
| `customerSuggestion` | a customer name the model read out of the uploaded documents, waiting for the PM to accept or dismiss. Held apart from `customer` on purpose: a file produces a candidate, never an approved fact |
| `preferredApproach` | the governance model the PM declared before any analysis, or null. **Null is a real answer** — it is what puts the planning analysis into recommend mode instead of assess mode |

## Flow 1 — input

| Model | Purpose |
| --- | --- |
| `InputFieldDefinition` | the schema of the minimum profile, per `ProjectType`; `signalKey` is what the prompts read |
| `ProjectInputValue` | one answer per project × definition, with `source` and `verified` |
| `ProjectCustomField` | extra PM signals, routed to the analysis, documents or both |
| `ReferenceFile` | uploads with `status` and a JSON `extraction` holding the text read on upload |

The `source` enum is what keeps file data honest: `PM_INPUT`, `FILE_REFERENCE`, `AI_SUGGESTED`.

**A `PM_INPUT` value is verified the moment the PM saves it.** It used to wait for a "Verify input"
button; that button is gone (the analysis reads the documents directly), so nothing else would ever
promote it and input readiness would sit at half for a fully-filled form. The rule that mattered is
untouched: a *document* still never becomes an approved fact on its own.

`ReferenceFile.group = DESCRIPTION` is a fifth, unclassified slot: the project description
document, which the analysis refuses to run without. Every uploaded file — the four classified
groups included — has its text read on upload into `extraction.rawText` by `lib/extract-text.ts`,
which handles `.txt`, `.pdf`, `.docx`, `.xlsx` and `.pptx`. Pre-2007 binaries (`.doc`, `.xls`,
`.ppt`) and scanned PDFs are stored and flagged, never silently accepted as readable.

## Flow 2 — planning analysis

| Model | Purpose |
| --- | --- |
| `AiApproachSuggestion` | an immutable analysis snapshot (see the field table below) |
| `ApproachDecision` | the PM gate; `approach` is a free-form governance-model string (not an enum — the AI can propose one outside the default six); `documentPack` freezes the generation contract, `active` marks the current one |

`AiApproachSuggestion` began as a governance-model recommendation and grew into the whole Planning
Review screen. Its columns split into two generations:

| Field | Written by | Feeds |
| --- | --- | --- |
| `recommendedApproach`, `confidence`, `confidenceLevel`, `rationale`, `reasons`, `evidence`, `risks`, `alternatives` | both paths | the Approach Advisory panel |
| `overview` | `analyzePlanningNeeds` | the Planning Review top panel — what the project *is*, per block |
| `planningGaps` | `analyzePlanningNeeds` | the Planning Gaps panel **and** the Studio's document filter, via each gap's `documentName` |
| `findings` | `analyzePlanningNeeds` | Risks & limitations — contradictions *between* uploaded documents |
| `approachMode` | `analyzePlanningNeeds` | `RECOMMENDED` (alternatives offered and switchable) or `PM_CHOSEN` (one model, scored, nothing to switch to) |
| `aiProvider` | both paths | `"anthropic"` or `"mock"` — the older path falls back to the deterministic writer on any error and the two must never be confused |

`evidence` holds `{ english, original?, source }` objects: the English rendering, the source
sentence verbatim in its own language, and the file it came from. Snapshots written before that
shape existed hold a plain `string[]`, so `latestEvaluation` normalises on read rather than
rewriting an immutable row.

Re-deciding deactivates the previous `ApproachDecision` instead of updating it, so the history of
what was promised at each point stays intact.

## Flow 3 — documents

| Model | Purpose |
| --- | --- |
| `DocumentDefinition` | catalog entry per `projectType × domain × name`, with `requirement` and `conditionKey`. Six entries — Project Charter, Organization Chart, RACI Matrix, Communication Plan, Change / Escalation Flow, **Risk Management Plan** — are required for every project regardless of governance model; only their internal structure varies (`data/governance-models.ts`) |
| `DocumentTemplate` | legacy: still seeded and still read by `templateFit`, but the catalog no longer exposes it — the model chooses each document's structure |
| `PlanningDocument` | the project's instance: status, version, `sourceTrace`, `structuredData` (RACI table, risk register, org chart, register grid, or the template-fill record) and `pmQuestions`, which holds `DocumentGap` objects (`{ token, question, answer }`) |
| `DocumentSection` | the sections the model returned, in order |

Status path: `NOT_GENERATED → GENERATING → PM_REVIEW → APPROVED` (with `SUPERSEDED` for
re-versioning). Document *existence* does not depend on which governance model was confirmed —
`syncDocumentsWithPack` provisions every catalog document for the project's type regardless. What
the Planning Studio *shows* is narrower: the documents the last analysis named as gaps, plus the
kickoff deck.

`ManagementDomain` carries two values that hold no catalog entries in the current configuration:
`KICKOFF` holds only the kickoff deck, and `PROJECT_PLAN` is empty — the Project Plan document was
retired, and the enum value stays so old rows still read.

`pmQuestions` predates gaps and once held plain strings, so `readGaps()` normalises both shapes on
read; rows generated before the change keep working.

## The customer reference library

A checklist belongs to a **customer**, not to a project — uploaded once, applied to every project
for that customer.

| Model | Purpose |
| --- | --- |
| `Customer` | `key`, `name`, and `aliases` — the spellings and rules the free-text `Project.customer` is matched against. Optional `logoKey` for branding generated files |
| `CustomerChecklist` | one uploaded checklist file, versioned: a new upload deactivates the previous one rather than replacing it, so a project assessed against v1 stays explainable after v2 lands. `parseNote` records what the parser read |
| `ChecklistItem` | one check, with the source's own `section` / `text` / `guidance` / `expected`, plus `sectionEn` / `textEn` / `guidanceEn` — English readings written once at upload, because the interface is English while the checklists are usually Korean |
| `CustomerTemplate` | the customer's own `.pptx` / `.docx` / `.xlsx`, stored as the original binary with the `placeholders` the scanner found, so generation can fill it in place |
| `ProjectChecklistAssessment` | one project scored against one checklist version, with `runState`, `stale` and `aiProvider` |
| `ChecklistAssessmentItem` | one verdict per item: `status`, `source` (`DETERMINISTIC` / `AI` / `PM`), `evidence` and `note` |

An alias is either a spelling (`SK C&C`), a prefix rule (`SK*` — the whole corporate group), or
`*`, the house default used when nothing else matched. `matchCustomer` reports which fired, and
`default` is deliberately not treated as knowing the customer.

## Control center and trace

| Model | Purpose |
| --- | --- |
| `ActionItem` | PM action center; `blocksDocument` is what enforces "resolve before generate" |
| `PlanningTask` | setup workflow board |
| `DomainReadiness` | per-domain score with an 80% target |
| `AuditEvent` | append-only trail with `actorType` = PM / AGENT / SYSTEM. `projectId` is **nullable**: a customer-library change is a platform event belonging to no project |
| `AgentSession` | one chat thread, private to its `(project, user)` pair |
| `AgentMessage` | the turns in a thread; `meta` records what the reply was based on |
| `DashboardLayout` | per user × project widget visibility |
| `ExportJob` | approved-baseline export requests, always scoped to approved content — separate from the per-document Office / dashboard `.html` downloads, which are rendered on demand and not persisted |

## Indexes worth knowing

- `projects(status)`, `projects(programId)` and `projects(ownerId)` — program overview filtering.
- `planning_documents(projectId, status)` — dashboard output counters.
- `audit_events(projectId, createdAt)` and `agent_messages(projectId, createdAt)` — timeline reads.
- `ai_approach_suggestions(projectId, createdAt)` — latest-analysis lookups.
- `customer_checklists(customerId, active)` and `checklist_items(checklistId, order)` — library reads.
- Compound uniques prevent duplicates: one value per project × field, one document per project ×
  definition, one layout per project × user, one assessment per project × checklist.
