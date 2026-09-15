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

## Customer reference library

Each customer's checklists and document templates, uploaded once and reused by every project for
them. **Readable by any signed-in account** — a project owner needs to see what their project will
be assessed against. **Writable only by `PROGRAM_OWNER` and `ADMIN`**: the library is configuration
rather than delivery data, which is the one place an administrator touches something outside the
account console.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/customers` | every customer with their checklists (and item counts), templates (with the placeholders found in each) and whether a logo is set |
| GET | `/customers/resolve?customer=…` | what the library holds for a **free-text** customer name. Returns `{ matched: true, confidence: 'exact' \| 'partial', matchedOn, customer }` or `{ matched: false, known: [...] }`. A suggestion for the PM to confirm — never applied on its own |
| POST | `/customers` | `{ name, key?, aliases? }` — `key` is derived from the name when omitted |
| PATCH | `/customers/:customerId` | `{ name?, aliases?, active? }` |
| DELETE | `/customers/:customerId` | cascades the checklists, items and templates, and removes their stored files |
| POST | `/customers/:customerId/checklists` | multipart `file` (+ `name`) — `.xlsx` / `.docx`. Parsed on upload into `ChecklistItem` rows; the response carries the item count and the parse note. A new upload **supersedes** the previous version rather than replacing it |
| GET | `/customers/checklists/:checklistId/items` | the parsed rows, so the upload can be checked against the original |
| DELETE | `/customers/checklists/:checklistId` | |
| POST | `/customers/:customerId/templates` | multipart `file` + `documentType` — `.pptx` / `.docx`. Scanned for placeholders; each is reported with its occurrences, locations and whether it is **split across text runs** (which filling must handle) |
| DELETE | `/customers/templates/:templateId` | |
| POST | `/customers/:customerId/logo` | multipart `file` — `.png` / `.jpg` / `.svg` / `.webp` |
| GET | `/customers/(checklists\|templates\|logo)/:id/file` | the stored original. 404 with an explicit message if the row exists but its file is missing from `UPLOAD_DIR` |

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
| GET | `/projects/:id/input` | fields, counters, custom fields, reference groups, description document, missing information, plus `customer` and any pending `customerSuggestion` |
| PUT | `/projects/:id/input` | `{ values: [{ definitionId, value }] }` — saves as `PM_INPUT`, resets `verified` |
| POST | `/projects/:id/input/verify` | Two things in one step: reads every uploaded file (deterministic option matcher, then Skill 0 for what it cannot resolve) and writes what it resolved into *empty* fields as `AI_SUGGESTED` + unverified, then verifies the PM's own `PM_INPUT` values. Returns `{ verified, prefilled, documentsRead, stillEmpty, provider, customerSuggestion }` — `provider: "mock"` means the extraction model was unreachable |
| POST | `/projects/:id/input/customer-suggestion` | `{ action: "accept" \| "dismiss", value? }` — the PM's decision on the customer Skill 0 read from the documents. **Accepting is the only thing that writes `Project.customer`**, which is what makes that customer's checklist and templates apply; `value` lets the PM correct the proposed name first. Dismissing clears the proposal and changes nothing. Both write an `AuditEvent` |
| POST | `/projects/:id/custom-fields` | `{ name, value?, useIn: RULES\|DOCUMENT\|BOTH }` |
| DELETE | `/projects/:id/custom-fields/:fieldId` | |
| POST | `/projects/:id/actions/:actionId/resolve` | `{ value }` — writes the answer back into the input profile |
| POST | `/projects/:id/references` | multipart: `file`, `group: COMMITMENT\|SCOPE\|ORGANIZATION\|SCHEDULE\|OTHER` — `OTHER` is the catch-all slot for any project document; it is read on Verify exactly like the classified ones |
| GET | `/projects/:id/references/:fileId` | metadata + the text extracted on upload, for the preview panel |
| GET | `/projects/:id/references/:fileId/file` | the original bytes, `Content-Disposition: inline` so a PDF opens in the browser viewer |
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
| GET | `/projects/:id/documents/:documentId` | full draft with sections, plus `exportFormat` |
| GET | `/projects/:id/documents/:documentId/slides` | the deck this document downloads as, read out of the **real rendered file** — `{ fileName, template, slides: [{ number, lines, pictures, hasTable }] }`. What the on-screen preview draws, so it cannot disagree with the download. 400 for a document that is not a deck. No model call |
| GET | `/projects/:id/documents/:documentId/export` | the real Office file for this document, rendered on demand (any status, not just approved). The **server** picks the container — a RACI document comes back as `.xlsx`, everything else as `.docx` — and reports it in `Content-Type` and `Content-Disposition`. Each catalog entry carries the same answer as `exportFormat` so the UI can label the button |
| GET | `/projects/:id/documents/:documentId/export.docx` | forces the Word rendering, whatever the document is |
| GET | `/projects/:id/documents/:documentId/export.xlsx` | forces the spreadsheet rendering — a register document as its own grid, or the RACI matrix as a grid with prose on a *Narrative* sheet. No exported file carries the PM question list; unanswered blanks render in place as "[ answer needed ]" |
| GET | `/projects/:id/dashboard/export.html` | the project overview dashboard as a real, self-contained `.html` file |
| POST | `/projects/:id/exports` | `{ format: DOCX\|XLSX\|PDF\|CONFLUENCE }` — approved documents only, recorded as an `ExportJob` |

## Dashboard, activity and agent

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/dashboard` | readiness verdict, outputs, tasks, actions, domain bars, activity, widget layout, and `library` — every document attached to the project, each tagged `origin: PM_INPUT \| AI_GENERATED` and `kind: UPLOAD \| GENERATED` (which decides whether the UI opens the upload preview or the document preview) |
| GET | `/projects/:id/documents/:documentId` | one generated document with its sections and gaps — what the dashboard previews |
| PUT | `/projects/:id/dashboard/layout` | `{ widgets: { readiness: true, ... } }` |
| GET | `/projects/:id/activity?limit=30` | audit trail |
| GET | `/projects/:id/agent/sessions` | the caller's chat threads, newest activity first |
| POST | `/projects/:id/agent/sessions` | starts a thread; titled from its first question |
| GET | `/projects/:id/agent/sessions/:sessionId/messages` | one thread's messages; 403 if it belongs to another user |
| POST | `/projects/:id/agent/sessions/:sessionId/messages` | `{ question }` — the thread's earlier turns are replayed to the model. Reply is advisory, `meta.decisionApplied` is always `false` |
| PATCH | `/projects/:id/agent/sessions/:sessionId` | `{ title }` |
| DELETE | `/projects/:id/agent/sessions/:sessionId` | messages cascade |

## Status codes

`200` ok · `201` created · `400` validation or blocked precondition · `401` missing/expired token ·
`403` role not allowed · `404` not found · `409` unique conflict or regeneration of an approved document.
