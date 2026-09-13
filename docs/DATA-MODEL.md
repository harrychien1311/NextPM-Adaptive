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

## Flow 1 — input

| Model | Purpose |
| --- | --- |
| `InputFieldDefinition` | the schema of the minimum profile, per `ProjectType`; `signalKey` is what the recommendation prompt reads |
| `ProjectInputValue` | one answer per project × definition, with `source` and `verified` |
| `ProjectCustomField` | extra PM signals, routed to the recommendation, documents or both |
| `ReferenceFile` | optional uploads with `status` and a JSON `extraction` of candidate values |

The `source` enum is what keeps file data honest: `PM_INPUT`, `FILE_REFERENCE`, `AI_SUGGESTED`.
Only PM verification flips `verified`, and "Verify input" verifies `PM_INPUT` rows only — the
values it extracted in the same run stay unverified for the PM to review.

`InputFieldDefinition.required` is true for exactly two fields per project type (the name and the
objective); the rest are optional signals. Readiness is therefore scored over *all* fields — see
ARCHITECTURE.md.

`ReferenceFile.group = DESCRIPTION` is a fifth, unclassified slot: a free-form project
description document. Every uploaded file — the four classified groups included — has its text
read on upload into `extraction.rawText`; deciding what that text *means* happens later, on
"Verify input" (Skill 0, for the form fields) and on the recommendation (Skill 1, for the
governance model).

## Flow 2 — governance model recommendation

| Model | Purpose |
| --- | --- |
| `AiApproachSuggestion` | an immutable Skill 1 snapshot: `recommendedApproach`, `confidence` (0-100), `confidenceLevel`, `rationale`, `reasons`/`evidence`/`risks`/`alternatives` (JSON string/object arrays), `candidateValues`, and `aiProvider` — `"anthropic"` or `"mock"`, since the AI call falls back to the deterministic writer on any error and the two must not be confused |
| `ApproachDecision` | the PM gate; `approach` is a free-form governance-model string (not an enum — the AI can propose one outside the default six); `documentPack` freezes the generation contract, `active` marks the current one |

`AiApproachSuggestion` is written by `rules.service.ts`'s `runEvaluation()`, which calls Skill 1
(`recommendGovernanceModel()` in `modules/ai/provider.ts`). `ApproachDecision.evaluationId`
points at the snapshot the PM decided from. Re-deciding deactivates the previous decision instead
of updating it, so the history of what was promised at each point stays intact.

## Flow 3 — documents

| Model | Purpose |
| --- | --- |
| `DocumentDefinition` | catalog entry per `projectType × domain × name`, with `requirement` and `conditionKey`. Six entries — Project Charter, Organization Chart, RACI Matrix, Communication Plan, Change / Escalation Flow, Risk Plan — are required for every project regardless of governance model; only their internal structure varies (`data/governance-models.ts`) |
| `DocumentTemplate` | legacy: still seeded and still read by `templateFit`, but the catalog no longer exposes it — the model chooses each document's structure |
| `PlanningDocument` | the project's instance: status, version, `sourceTrace`, `structuredData` (RACI table / risk register rows, used by the `.docx` and dashboard exports), and `pmQuestions` — which holds `DocumentGap` objects (`{ token, question, answer }`) |
| `DocumentSection` | the sections the model returned, in order |

Status path: `NOT_GENERATED → GENERATING → PM_REVIEW → APPROVED` (with `SUPERSEDED` for
re-versioning). Document *existence* no longer depends on which governance model was confirmed —
`syncDocumentsWithPack` provisions every catalog document for the project's type regardless.

`pmQuestions` predates gaps and once held plain strings, so `readGaps()` normalises both shapes on
read; rows generated before the change keep working.

## Control center and trace

| Model | Purpose |
| --- | --- |
| `ActionItem` | PM action center; `blocksDocument` is what enforces "resolve before generate" |
| `PlanningTask` | setup workflow board |
| `DomainReadiness` | per-domain score with an 80% target |
| `AuditEvent` | append-only trail with `actorType` = PM / AGENT / SYSTEM |
| `AgentMessage` | conversation, `meta` records what the reply was based on |
| `DashboardLayout` | per user × project widget visibility |
| `ExportJob` | approved-baseline export requests, always scoped to approved content — separate from the per-document `.docx` / dashboard `.html` downloads, which are rendered on demand and not persisted |

## Indexes worth knowing

- `projects(status)`, `projects(programId)` and `projects(ownerId)` — program overview filtering.
- `planning_documents(projectId, status)` — dashboard output counters.
- `audit_events(projectId, createdAt)` and `agent_messages(projectId, createdAt)` — timeline reads.
- `ai_approach_suggestions(projectId, createdAt)` — latest-recommendation lookups.
- Compound uniques prevent duplicates: one value per project × field, one document per project ×
  definition, one layout per project × user.
