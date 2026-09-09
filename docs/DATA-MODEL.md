# Data model

See `backend/prisma/schema.prisma` for field detail. Grouped by responsibility below.

## Identity and hierarchy

```
User ──owns──► Portfolio ──has──► Program ──has──► Project
                    └────────── standalone ─────────┘
Project ──has──► ProjectMember ──► User
```

- `Program.key` is a stable slug used by the UI for filtering.
- `Project.programId` is nullable: a null value means a standalone project at portfolio level.

## Flow 1 — input

| Model | Purpose |
| --- | --- |
| `InputFieldDefinition` | the schema of the minimum profile, per `ProjectType`; `signalKey` is what the recommendation prompt reads |
| `ProjectInputValue` | one answer per project × definition, with `source` and `verified` |
| `ProjectCustomField` | extra PM signals, routed to the recommendation, documents or both |
| `ReferenceFile` | optional uploads with `status` and a JSON `extraction` of candidate values |

The `source` enum is what keeps file data honest: `PM_INPUT`, `FILE_REFERENCE`, `AI_SUGGESTED`.
Only PM verification flips `verified`.

`ReferenceFile.group = DESCRIPTION` is a fifth, unclassified slot: a free-form project
description document. Its text is read on upload (`extraction.rawText`), but the AI only reads
that text when the PM asks for a governance-model recommendation (flow 2) — not on verify.

## Flow 2 — governance model recommendation

| Model | Purpose |
| --- | --- |
| `AiApproachSuggestion` | an immutable Skill 1 snapshot: `recommendedApproach`, `confidence` (0-100), `confidenceLevel`, `rationale`, `reasons`/`evidence`/`risks`/`alternatives` (JSON string/object arrays), `candidateValues` |
| `ApproachDecision` | the PM gate; `approach` is a free-form governance-model string (not an enum — the AI can propose one outside the default six); `documentPack` freezes the generation contract, `active` marks the current one |

`AiApproachSuggestion` is written by `rules.service.ts`'s `runEvaluation()`, which calls Skill 1
(`recommendGovernanceModel()` in `modules/ai/provider.ts`). `ApproachDecision.evaluationId`
points at the snapshot the PM decided from. Re-deciding deactivates the previous decision instead
of updating it, so the history of what was promised at each point stays intact.

## Flow 3 — documents

| Model | Purpose |
| --- | --- |
| `DocumentDefinition` | catalog entry per `projectType × domain × name`, with `requirement` and `conditionKey`. Six entries — Project Charter, Organization Chart, RACI Matrix, Communication Plan, Change / Escalation Flow, Risk Plan — are required for every project regardless of governance model; only their internal structure varies (`data/governance-models.ts`) |
| `DocumentTemplate` | three per definition (`standard`, `lean`, `delivery`), sections as JSON |
| `PlanningDocument` | the project's instance: status, version, `sourceTrace`, `pmQuestions`, `structuredData` (RACI table / risk register rows, used by the `.docx` and dashboard exports) |
| `DocumentSection` | the generation contract row-by-row: `included` decides what gets written |

Status path: `NOT_GENERATED → GENERATING → PM_REVIEW → APPROVED` (with `SUPERSEDED` for
re-versioning). Document *existence* no longer depends on which governance model was confirmed —
`syncDocumentsWithPack` provisions every catalog document for the project's type regardless.

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

- `projects(portfolioId, status)` and `projects(programId)` — portfolio overview filtering.
- `planning_documents(projectId, status)` — dashboard output counters.
- `audit_events(projectId, createdAt)` and `agent_messages(projectId, createdAt)` — timeline reads.
- `ai_approach_suggestions(projectId, createdAt)` — latest-recommendation lookups.
- Compound uniques prevent duplicates: one value per project × field, one document per project ×
  definition, one layout per project × user.
