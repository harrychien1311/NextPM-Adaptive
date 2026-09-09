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
engine — the governance-model recommendation and every document draft are LLM calls, made through
two independent "skills" in `ai/provider.ts` (see below), each with a deterministic mock fallback
so the app runs with no API key.

## The two AI skills

- **Skill 1 — `recommendGovernanceModel()`.** Reads verified `ProjectInputValue`s and the text
  extracted from an optional uploaded project description document, and returns a governance
  model (Waterfall, Scrum, Kanban, Hybrid, Iterative, Predictive/Stage-Gate, or another it
  justifies from evidence), a 0-100 suitability score, confidence level, reasons, evidence, risks
  and every scored alternative, as strict JSON. Stored as an immutable `AiApproachSuggestion`.
- **Skill 2 — `generateDocument()` / `generateGovernanceArtifact()`.** Drafts one planning
  document once the PM has confirmed a governance model. `generateGovernanceArtifact()` handles
  the six documents required for every project regardless of model (Project Charter, Organization
  Chart, RACI Matrix, Communication Plan, Change / Escalation Flow, Risk Plan), using per-model
  structure guidance from `data/governance-models.ts`; `generateDocument()` handles every other
  catalog document generically.

These are never combined into one prompt — Skill 1 runs once per recommendation request, Skill 2
runs once per document generated.

## Module boundaries

| Module | Owns |
| --- | --- |
| `auth` | credentials, JWT issuing, role checks |
| `portfolio` | hierarchy, project provisioning, readiness computation |
| `input` | input values, verification state, references, action resolution, domain readiness |
| `rules` | the AI recommendation snapshot, approach options, the PM decision gate — keeps its original folder name from when it held a rule engine, but is LLM-driven now |
| `documents` | catalog, templates, generation contract, drafting, approval, `.docx`/`.html` export |
| `dashboard` | read-only aggregation for the control center |
| `agent` | conversation persistence + advisory replies |
| `audit` | append-only event log |
| `ai` | the only place that talks to a model — hosts both skills |

`rules.service` calls `documents.service` (after a decision, provision the pack). The reverse
never happens, so there is no cycle.

## Invariants enforced server-side

1. **Verification precedes recommendation.** Only values with `verified = true` are treated as
   facts; a file extraction lands as a candidate, never as an approved value.
2. **No generation before the decision gate.** `generateDraft` refuses without an active
   `ApproachDecision`.
3. **Required blockers block.** An open `ActionItem` with `priority = REQUIRED` and
   `blocksDocument = X` prevents generating X.
4. **Only the contract is written.** Sections with `included = false` are never sent to the model
   and never receive content.
5. **Approval is a distinct step.** Generation ends at `PM_REVIEW`; only an explicit approve call
   sets `APPROVED`, stamping `approvedById` and `approvedAt`.
6. **Overrides need a reason.** `outcome = OVERRIDDEN` without a rationale is a 400.
7. **Exports carry approved content only.** Drafts and unresolved values are excluded from the
   approved-baseline export; the per-document `.docx` / dashboard `.html` downloads are working
   drafts and sit outside that policy.
8. **Everything is traceable.** Recommendations, generations, approvals and exports all write an
   `AuditEvent` with actor and payload.

## Readiness maths

- *Input readiness* = `(filled + verified) / (required × 2)` — filling a field gets you halfway,
  PM verification gets you the rest.
- *Domain readiness* = share of that domain's required inputs which are filled **and** verified.
- *Project readiness* = 50% input readiness + 50% approved-output share once documents exist,
  otherwise input readiness alone.
- *Portfolio readiness* = unweighted mean over active projects; program roll-up is the same over
  its active projects.

## Scaling notes

- Recommendation snapshots (`AiApproachSuggestion`) are append-only, so a recommendation can
  always be replayed as it stood when the PM decided.
- Generation is synchronous today. For long documents, move `generateDraft` behind a queue
  (BullMQ + Redis): the `GENERATING` status already exists for that transition.
- `.docx`/`.html` exports are rendered on demand from the database on every download — nothing is
  cached or persisted to disk. If that becomes hot, cache the rendered buffer per document version.
- The dashboard is several aggregates in one round trip; if it becomes hot, cache per project and
  invalidate on any `AuditEvent` write.
