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
engine — document extraction, the governance-model recommendation and every document draft are LLM
calls, made through three independent "skills" in `ai/provider.ts` (see below). The two governance
skills carry a deterministic mock fallback so the app runs with no API key.

## The three AI skills

- **Skill 0 — `extractInputValues()`.** Answers still-empty input fields from the text of every
  uploaded file. Runs on "Verify input" as **stage 2**, after `lib/option-match.ts` has resolved
  whatever the document happens to quote literally, so the model only sees the remainder. Its
  prompt states that documents may be in any language while SELECT options are fixed English
  identifiers to return verbatim — exactly the case literal matching can never handle. No mock
  fallback: a blank the PM fills in beats an invented value.
- **Skill 1 — `recommendGovernanceModel()`.** Reads verified `ProjectInputValue`s and the text
  extracted from an optional uploaded project description document, and returns a governance
  model (Waterfall, Scrum, Kanban, Hybrid, Iterative, Predictive/Stage-Gate, or another it
  justifies from evidence), a 0-100 suitability score, confidence level, reasons, evidence, risks
  and every scored alternative, as strict JSON. Stored as an immutable `AiApproachSuggestion`.
- **Skill 2 — `generateDocument()` / `generateGovernanceArtifact()`.** Drafts one planning
  document once the PM has confirmed a governance model, **choosing its own section structure** —
  templates were removed. `generateGovernanceArtifact()` handles the six documents required for
  every project regardless of model (Project Charter, Organization Chart, RACI Matrix,
  Communication Plan, Change / Escalation Flow, Risk Plan), using per-model structure guidance
  from `data/governance-models.ts`; `generateDocument()` handles every other catalog document
  generically. Neither may invent a missing fact: an unknown becomes a `{{gap:N}}` token in the
  prose plus a question for the PM, which `fillDocumentGaps` later substitutes the answer into.

These are never combined into one prompt — Skill 0 runs once per "Verify input", Skill 1 once per
recommendation request, Skill 2 once per document generated.

Skill 1 and Skill 2 fall back to the deterministic mock whenever the API call throws, so
`recommendGovernanceModel()` returns a `provider` that is stored as
`AiApproachSuggestion.aiProvider` and shown as a warning banner. Without it, a keyword heuristic
and a real recommendation look identical.

## Module boundaries

| Module | Owns |
| --- | --- |
| `auth` | credentials, JWT issuing, role checks |
| `admin` | account administration (create / role / reset password / deactivate / delete) — administrator-only, and the only place a role is assigned |
| `program` | program + project hierarchy, project provisioning, per-user access, readiness computation |
| `input` | input values, verification state, references, action resolution, domain readiness |
| `rules` | the AI recommendation snapshot, approach options, the PM decision gate — keeps its original folder name from when it held a rule engine, but is LLM-driven now |
| `documents` | catalog, templates, generation contract, drafting, approval, `.docx`/`.html` export |
| `dashboard` | read-only aggregation for the control center |
| `agent` | conversation persistence + advisory replies |
| `audit` | append-only event log |
| `ai` | the only place that talks to a model — hosts all three skills |

`rules.service` calls `documents.service` (after a decision, provision the pack). The reverse
never happens, so there is no cycle.

## Invariants enforced server-side

1. **Verification precedes recommendation.** Only values with `verified = true` are treated as
   facts; a file extraction lands as a candidate, never as an approved value. `verifyInputs`
   verifies `source = PM_INPUT` rows only, so the values it extracts in the same run stay
   unverified until the PM has looked at them.
2. **No generation before the decision gate.** `generateDraft` refuses without an active
   `ApproachDecision`.
3. **Required blockers block.** An open `ActionItem` with `priority = REQUIRED` and
   `blocksDocument = X` prevents generating X.
4. **The model never invents a missing fact.** Both Skill 2 prompts forbid inventing a date, name,
   number, owner or placeholder; an unknown becomes a `{{gap:N}}` token plus a PM question, and
   only answered tokens are ever substituted.
5. **Approval is a distinct step.** Generation ends at `PM_REVIEW`; only an explicit approve call
   sets `APPROVED`, stamping `approvedById` and `approvedAt`.
6. **Overrides need a reason.** `outcome = OVERRIDDEN` without a rationale is a 400.
7. **Exports carry approved content only.** Drafts and unresolved values are excluded from the
   approved-baseline export; the per-document `.docx` / dashboard `.html` downloads are working
   drafts and sit outside that policy.
8. **Everything is traceable.** Recommendations, generations, approvals and exports all write an
   `AuditEvent` with actor and payload.
9. **Workspace access is proven per request.** Every `:projectId` router mounts
   `requireProjectMember`, which admits only the program owner, the project's owner, or a
   `ProjectMember` row — administrators included in the refusal.
10. **Privilege is only granted by an administrator.** `auth.service.register` hard-codes
    `PROJECT_OWNER` and ignores any role in the request body; `PROGRAM_OWNER` and `ADMIN` exist
    only through the admin console.

## Readiness maths

- *Input readiness* = `(filled + verified) / (allFields × 2)` — filling a field gets you halfway,
  PM verification gets you the rest. Scored over every field of the project type: only two fields
  are required, so a required-only denominator would read 100% with most of the form blank.
- *Domain readiness* = share of that domain's inputs which are filled **and** verified, likewise
  over all of the domain's fields.
- *Project readiness* = 50% input readiness + 50% approved-output share once documents exist,
  otherwise input readiness alone.
- *Delivery readiness* = unweighted mean over active projects; program roll-up is the same over
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
