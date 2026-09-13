# NextPM Adaptive — API reference

Base URL: `http://localhost:4000/api`
All endpoints except `/auth/*` require `Authorization: Bearer <token>`.
Errors return `{ "error": { "message": string, "details"?: unknown } }`.

Account roles (`User.role`): `PROGRAM_OWNER` creates programs and projects and may open every
workspace; `PROJECT_OWNER` creates projects and may open only the ones it owns or was granted;
`ADMIN` manages accounts and is refused on every delivery route. Project roles
(`ProjectMember.role`) are separate: `OWNER` may write, `MEMBER` / `VIEWER` may read.

## Auth

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/auth/login` | `{ email, password }` | `{ token, user }` |
| POST | `/auth/register` | `{ email, name, password, jobTitle? }` | `{ token, user }` — always creates a `PROJECT_OWNER`; the role can never be chosen here |
| GET | `/auth/me` | — | `{ user }` |

## Admin console (`ADMIN` only)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/users` | every account with its role, status and project counts |
| POST | `/admin/users` | `{ email, name, password, jobTitle?, role }` — the only way a `PROGRAM_OWNER` or `ADMIN` account is created |
| PATCH | `/admin/users/:userId` | `{ name?, jobTitle?, role?, active? }` — refuses self role-change / self-deactivation and demoting the last admin |
| POST | `/admin/users/:userId/password` | `{ password }` — administrator password reset |
| DELETE | `/admin/users/:userId` | refuses self-deletion, the last admin, and any account that still owns projects (deactivate instead) |

## Programs & projects

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/programs/overview` | program groups, project cards, roll-up summary and `capabilities`; every card carries `canOpen` (may enter the workspace), `canEdit` (may PATCH) and `canDelete` (may DELETE) |
| POST | `/programs` | `{ name, description?, targetOutcome? }` — `PROGRAM_OWNER` only |
| PATCH | `/programs/:programId` | `{ name?, description?, targetOutcome? }` — `PROGRAM_OWNER` only; renaming re-slugs `key`, which must stay unique (409 otherwise) |
| DELETE | `/programs/:programId` | `PROGRAM_OWNER` only. **Does not delete its projects** — `Project.programId` is `SetNull`, so they become standalone. Returns `{ deleted, name, projectsReleased }` |
| POST | `/projects` | `{ name, type: SI\|SM\|PRODUCT, programId?, customer?, targetStart? }` — the caller becomes the project owner; provisions the input profile, tasks, domain readiness and dashboard layout |
| GET | `/projects/:projectId` | workspace header + readiness |
| PATCH | `/projects/:projectId` | `{ name?, status?, summary?, customer?, targetLabel?, programId? }` — project role `OWNER` |
| DELETE | `/projects/:projectId` | **Irreversible**: inputs, uploads, recommendations, decisions, documents and the audit trail all cascade. Stricter than PATCH — only the project's own `ownerId` or a `PROGRAM_OWNER`, so a co-owner member gets 403. Returns `{ deleted, name, documentsRemoved }` |
| GET | `/projects/:projectId/members` | project team |
| POST | `/projects/:projectId/members` | `{ email, role?: OWNER\|MEMBER\|VIEWER }` |
| DELETE | `/projects/:projectId/members/:userId` | the project owner cannot be removed |

## Flow 1 — Input & verify

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/input` | fields, counters, custom fields, reference groups, description document, missing information |
| PUT | `/projects/:id/input` | `{ values: [{ definitionId, value }] }` — saves as `PM_INPUT`, resets `verified` |
| POST | `/projects/:id/input/verify` | Two things in one step: reads every uploaded file (deterministic option matcher, then Skill 0 for what it cannot resolve) and writes what it resolved into *empty* fields as `AI_SUGGESTED` + unverified, then verifies the PM's own `PM_INPUT` values. Returns `{ verified, prefilled, documentsRead, stillEmpty, provider }` — `provider: "mock"` means the extraction model was unreachable |
| POST | `/projects/:id/custom-fields` | `{ name, value?, useIn: RULES\|DOCUMENT\|BOTH }` |
| DELETE | `/projects/:id/custom-fields/:fieldId` | |
| POST | `/projects/:id/actions/:actionId/resolve` | `{ value }` — writes the answer back into the input profile |
| POST | `/projects/:id/references` | multipart: `file`, `group: COMMITMENT\|SCOPE\|ORGANIZATION\|SCHEDULE` — the four classified reference groups |
| DELETE | `/projects/:id/references/:fileId` | also removes the project description document |
| POST | `/projects/:id/description` | multipart: `file` (PDF/DOCX/TXT) — the project description document; text is extracted immediately, read by the AI on the next recommendation |

## Flow 2 — Governance model recommendation

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/approach` | `{ evaluation, options[], decision }` |
| POST | `/projects/:id/approach/evaluate` | Skill 1: asks the AI to recommend a governance model from verified inputs + the project description document; stores an `AiApproachSuggestion` snapshot |
| POST | `/projects/:id/approach/decide` | `{ approach, outcome: CONFIRMED\|OVERRIDDEN, rationale? }` — rationale required for an override; freezes the document pack |

`evaluation.approach` (and every `options[].approach`) is a free-form governance-model string —
`WATERFALL`, `SCRUM`, `KANBAN`, `HYBRID`, `ITERATIVE`, `STAGE_GATE` by default, or another the AI
justified from evidence. Recommendation response shape:

```json
{
  "evaluation": {
    "recommendedApproach": "HYBRID",
    "confidence": 86,
    "confidenceLevel": "HIGH",
    "rationale": "Fixed commercial commitments combined with iterative delivery language justify a blended model.",
    "reasons": ["Evidence of \"fixed price\"", "Evidence of \"increment every\""],
    "evidence": ["fixed price", "increment every"],
    "risks": [],
    "alternatives": [
      { "approach": "WATERFALL", "score": 64, "rationale": "Evidence of fixed price" },
      { "approach": "SCRUM", "score": 58, "rationale": "Evidence of increment every" }
    ],
    "candidateValues": [{ "fieldKey": "contractModel", "label": "Contract model", "value": "Fixed price" }]
  }
}
```

## Flow 3 — Generate & approve

A document's unknown facts come back as **gaps**: the model writes the literal token `{{gap:N}}`
into the prose instead of inventing anything, and returns
`document.gaps = [{ token, question, answer }]`. Answer them with `POST …/gaps`, then write them in
with `POST …/fill`.


| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/documents?domain=GOVERNANCE` | catalog, current document state (including `document.gaps` and `document.structuredData` — the RACI / risk rows the preview and the `.docx` both render), domain tab counts. Six documents — Project Charter, Organization Chart, RACI Matrix, Communication Plan, Change / Escalation Flow, Risk Plan — are required for every project regardless of governance model |
| GET | `/projects/:id/documents/:definitionId/fit` | project type / approach / rigor controls for the banner |
| POST | `/projects/:id/documents/generate` | `{ definitionId }` — Skill 2 picks the structure itself; no template, no section contract. 400 if a required action item blocks this document, 409 if the document is already approved |
| PUT | `/projects/:id/documents/:documentId/sections` | `{ sections: [{ title, content }] }` — "Edit content"; replaces the draft with the PM's own text |
| POST | `/projects/:id/documents/:documentId/gaps` | `{ token, answer }` — answers one "PM confirmation needed" item. Recorded only; the document is not changed yet |
| POST | `/projects/:id/documents/:documentId/fill` | "Fill out the document" — substitutes every answered token into the blank it came from, in section text and in the RACI / risk tables. 400 if nothing is answered |
| POST | `/projects/:id/documents/:documentId/approve` | only from `PM_REVIEW` |
| GET | `/projects/:id/documents/:documentId` | full draft with sections |
| GET | `/projects/:id/documents/:documentId/export.docx` | real `.docx` file for this document, rendered on demand (any status, not just approved) |
| GET | `/projects/:id/dashboard/export.html` | the project overview dashboard as a real, self-contained `.html` file |
| POST | `/projects/:id/exports` | `{ format: DOCX\|XLSX\|PDF\|CONFLUENCE }` — approved documents only, recorded as an `ExportJob` |

## Dashboard, activity and agent

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/dashboard` | readiness verdict, outputs, tasks, actions, domain bars, activity, widget layout |
| PUT | `/projects/:id/dashboard/layout` | `{ widgets: { readiness: true, ... } }` |
| GET | `/projects/:id/activity?limit=30` | audit trail |
| GET | `/projects/:id/agent/messages` | conversation history |
| POST | `/projects/:id/agent/messages` | `{ question }` — reply is advisory, `meta.decisionApplied` is always `false` |

## Status codes

`200` ok · `201` created · `400` validation or blocked precondition · `401` missing/expired token ·
`403` role not allowed · `404` not found · `409` unique conflict or regeneration of an approved document.
