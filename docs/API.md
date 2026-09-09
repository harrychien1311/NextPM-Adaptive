# NextPM Adaptive — API reference

Base URL: `http://localhost:4000/api`
All endpoints except `/auth/*` require `Authorization: Bearer <token>`.
Errors return `{ "error": { "message": string, "details"?: unknown } }`.

Roles: `ADMIN`, `PORTFOLIO_MANAGER`, `PROJECT_MANAGER` may write; `MEMBER`, `VIEWER` may read.

## Auth

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/auth/login` | `{ email, password }` | `{ token, user }` |
| POST | `/auth/register` | `{ email, name, password, jobTitle? }` | `{ token, user }` |
| GET | `/auth/me` | — | `{ user }` |

## Portfolio hierarchy

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/portfolios` | list with program/project counts |
| POST | `/portfolios` | `{ name, businessUnit?, strategicObjective? }` |
| GET | `/portfolios/:id/overview` | program groups, project cards, roll-up summary |
| POST | `/portfolios/:id/programs` | `{ name, description?, targetOutcome? }` |
| POST | `/portfolios/:id/projects` | `{ name, type: SI\|SM\|PRODUCT, programId?, customer?, targetStart? }` — provisions the input profile, tasks, domain readiness and dashboard layout |
| GET | `/projects/:projectId` | workspace header + readiness |
| PATCH | `/projects/:projectId` | `{ name?, status?, summary?, targetLabel?, programId? }` |
| GET | `/projects/:projectId/members` | project team |

## Flow 1 — Input & verify

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/input` | fields, counters, custom fields, reference groups, description document, missing information |
| PUT | `/projects/:id/input` | `{ values: [{ definitionId, value }] }` — saves as `PM_INPUT`, resets `verified` |
| POST | `/projects/:id/input/verify` | PM confirms current values; returns `{ verified }` |
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

## Flow 3 — Template, generate & approve

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/documents?domain=GOVERNANCE` | catalog with templates, current document state, domain tab counts. Six documents — Project Charter, Organization Chart, RACI Matrix, Communication Plan, Change / Escalation Flow, Risk Plan — are required for every project regardless of governance model |
| GET | `/projects/:id/documents/:definitionId/fit` | template fit score, reasons, controls |
| POST | `/projects/:id/documents/contract` | `{ definitionId, templateId, sections? }` — writes the generation contract |
| POST | `/projects/:id/documents/:documentId/generate` | Skill 2; 400 if a required action item blocks this document |
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
